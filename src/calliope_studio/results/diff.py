"""What differs between two resolved models, parameter by parameter.

Both sides are `LoadedModel`s — a run's `results.nc`, or a `resolved.nc` the
editor asked Calliope for — so this compares what Calliope *read* on each side,
never two structural guesses at the YAML. Templates, overrides, data tables and
`active:` have all been applied by the time an array reaches `inputs`, which is
the whole reason to diff here rather than in `modeldef`.

The answer is attributed to the things a modeller thinks in: a technology, a
link, a node, a carrier, or the model as a whole. A parameter with a `techs`
dimension belongs to its technology, whatever else it is indexed by; the other
dimensions become the `where` of the change. A time series is summarised —
how many timesteps differ, and the sums — because a list of 8,760 rows is not
something anybody reads.

Pure xarray and numpy, like the rest of this layer: no Calliope, no `modeldef`,
no `runs`. That is also why `same` below duplicates `yaml_io._same` rather than
importing it; `tests/test_model_diff.py` keeps the two in step.
"""

from __future__ import annotations

import json
import math
from collections.abc import Mapping
from typing import Any

import numpy as np
import xarray as xr

from calliope_studio.results.catalog import tech_base_techs, unit_for, units_from_math
from calliope_studio.results.store import LoadedModel

#: The dimensions that name a thing a change can belong to, in the order a
#: parameter is attributed: a `(nodes, techs)` array is a tech's, at a node.
ENTITY_DIMS = ("techs", "nodes", "carriers")

#: What each entity dimension's members are called in the payload.
KIND_OF_DIM = {"techs": "tech", "nodes": "node", "carriers": "carrier"}

#: Every kind the payload can carry, in display order. `link` is a tech whose
#: base tech is transmission; `model` collects parameters with no entity dim.
KINDS = ("tech", "link", "node", "carrier", "model")

#: Which (node, tech) pairs exist: `active` from Calliope 0.7.0, its predecessor
#: `definition_matrix` in files solved before it (the `results/geo.py` idiom).
#: Reported once per tech as a set of nodes, never walked as a parameter.
MATRIX_NAMES = ("active", "definition_matrix")

TIME_DIM = "timesteps"

#: A changed entity lists at most this many changes; the rest are counted.
MAX_CHANGES_PER_ENTITY = 200

#: A dimension that gained or lost members names at most this many of them.
MAX_LISTED_MEMBERS = 20

_MISSING = object()


def same(left: Any, right: Any) -> bool:
    """Type-strict structural equality, for config values.

    `True == 1` and `40 == 40.0` in Python, and both are edits to a YAML file —
    Calliope requires a node's coordinates to share a type, and a bool turned
    into an int changes what a flag means. Mappings compare without regard to
    key order; sequences in order. Two NaNs are the same absence.

    A twin of `modeldef.yaml_io._same`, which `results` may not import. It is
    symmetric where that one is not: `_same` forgives an integer arriving over
    JSON where the file holds an equal integral float, because JavaScript
    cannot say "the float 29"; here both sides come from Calliope, so nothing
    needs forgiving and `29.0` against `29` is a difference worth reporting.
    """
    if isinstance(left, bool) != isinstance(right, bool):
        return False
    if isinstance(left, int) != isinstance(right, int):
        return False
    if isinstance(left, Mapping) and isinstance(right, Mapping):
        return len(left) == len(right) and all(
            key in right and same(value, right[key]) for key, value in left.items()
        )
    if isinstance(left, list | tuple) and isinstance(right, list | tuple):
        return len(left) == len(right) and all(
            same(one, other) for one, other in zip(left, right, strict=True)
        )
    if isinstance(left, Mapping | list | tuple) or isinstance(
        right, Mapping | list | tuple
    ):
        return False
    if isinstance(left, float) and isinstance(right, float):
        if math.isnan(left) and math.isnan(right):
            return True
    return left == right


def plain(value: Any) -> Any:
    """A JSON-safe rendering of a value read out of an array or a config dict.

    NaN is the absence of a value in an xarray input, so it becomes `null`.
    Infinity is not: eighteen base parameters default to it and a user writes it
    as `.inf`, so it keeps that spelling — the one `yaml_io.to_plain` uses on the
    way to the editors — rather than reaching `json.dumps` as the bare token
    `Infinity`, which `JSON.parse` rejects and which would take the whole
    payload down for one unbounded parameter.
    """
    if isinstance(value, np.generic):
        value = value.item()
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    if isinstance(value, float):
        if math.isnan(value):
            return None
        if math.isinf(value):
            return ".inf" if value > 0 else "-.inf"
        return value
    if isinstance(value, Mapping):
        return {str(key): plain(item) for key, item in value.items()}
    if isinstance(value, list | tuple | set | frozenset):
        return [plain(item) for item in value]
    return value


def model_diff(
    a: LoadedModel, b: LoadedModel, declared_units: Mapping[str, str] | None = None
) -> dict:
    """Everything that differs between two resolved models.

    Args:
        a: The side to read as *before*.
        b: The side to read as *after*.
        declared_units: Calliope's own unit declarations, injected by the
            server as `build_catalog` has them injected — this layer may not
            import `modeldef.schema`.

    Returns:
        `{entities, config, dims, summary, empty}`. `entities` lists only what
        was added, removed or changed; unchanged ones are counted in
        `summary` per kind. `dims` states a coordinate set that grew or shrank
        once — a time subset is one row here rather than a change on every
        series. `empty` is the no-op signal: nothing in any of the three.
    """
    file_units = {**units_from_math(a.math), **units_from_math(b.math)}
    dims = _dims_diff(a.inputs, b.inputs)
    changes = _parameter_changes(a, b, declared_units or {}, file_units)
    entities, summary = _entities(a, b, changes, declared_units or {}, file_units)
    config = _config_diff(a.config, b.config)
    return {
        "entities": entities,
        "config": config,
        "dims": dims,
        "summary": summary,
        "empty": not entities and not config and not dims,
    }


# -- dimensions ---------------------------------------------------------------


def _label(value: Any) -> str:
    if isinstance(value, np.datetime64):
        return str(np.datetime_as_string(value, unit="m")).replace("T", " ")
    return str(value)


def _members(dataset: xr.Dataset, dim: str) -> list[str]:
    if dim not in dataset.dims:
        return []
    return [_label(value) for value in dataset[dim].values]


def _dims_diff(a: xr.Dataset, b: xr.Dataset) -> list[dict]:
    rows = []
    for dim in sorted(set(map(str, a.dims)) | set(map(str, b.dims))):
        before, after = _members(a, dim), _members(b, dim)
        if dim == TIME_DIM:
            if before == after:
                continue
            rows.append(
                {
                    "dim": dim,
                    "before": len(before),
                    "after": len(after),
                    "range": {
                        "before": [before[0], before[-1]] if before else None,
                        "after": [after[0], after[-1]] if after else None,
                    },
                }
            )
            continue
        gone, new = set(before) - set(after), set(after) - set(before)
        if not gone and not new:
            continue
        rows.append(
            {
                "dim": dim,
                "before": len(before),
                "after": len(after),
                "added": sorted(new)[:MAX_LISTED_MEMBERS],
                "removed": sorted(gone)[:MAX_LISTED_MEMBERS],
            }
        )
    return rows


# -- parameters ---------------------------------------------------------------


def _absent_like(other: xr.DataArray) -> xr.DataArray:
    """An all-missing array shaped like `other`, for a side that lacks it."""
    if other.dtype.kind in "OUS":
        return xr.full_like(other, None, dtype=object)
    return xr.full_like(other, np.nan, dtype=float)


def _aligned(
    xa: xr.DataArray, xb: xr.DataArray
) -> tuple[xr.DataArray, xr.DataArray, xr.DataArray]:
    """Both arrays on one grid, and where they differ.

    Timesteps are joined *inner* and everything else *outer*: a member that
    exists on one side only is a difference (and is reported by `_dims_diff`),
    but a timestep that exists on one side only is a subset — reported once,
    also by `_dims_diff` — and comparing values over it would turn one change
    into a change on every series.
    """
    if TIME_DIM in xa.dims or TIME_DIM in xb.dims:
        others = [d for d in set(xa.dims) | set(xb.dims) if d != TIME_DIM]
        xa, xb = xr.align(xa, xb, join="inner", exclude=others)
    xa, xb = xr.align(xa, xb, join="outer", exclude=[TIME_DIM])
    xa, xb = xr.broadcast(xa, xb)
    both_null = xa.isnull() & xb.isnull()
    changed = ~((xa == xb) | both_null)
    return xa, xb, changed


def _matrix_name(inputs: xr.Dataset) -> str | None:
    return next((name for name in MATRIX_NAMES if name in inputs), None)


def _defined_nodes(inputs: xr.Dataset, tech: str) -> set[str] | None:
    """The nodes a tech is defined at, or None when the file cannot say."""
    return _defined_along(inputs, "techs", tech, "nodes")


def _defined_along(
    inputs: xr.Dataset, dim: str, name: str, along: str
) -> set[str] | None:
    """The members of `along` where `name` is defined, per the matrix."""
    matrix = _matrix_name(inputs)
    if matrix is None:
        return None
    array = inputs[matrix]
    if dim not in array.dims or along not in array.dims:
        return None
    if name not in array[dim].values:
        return set()
    sliced = array.sel({dim: name}).fillna(0).astype(bool)
    extra = [str(d) for d in sliced.dims if str(d) != along]
    if extra:
        sliced = sliced.any(extra)
    return {str(value) for value in sliced[along].values[sliced.values]}


def _parameter_changes(
    a: LoadedModel,
    b: LoadedModel,
    declared_units: Mapping[str, str],
    file_units: Mapping[str, str],
) -> dict[tuple[str, str | None], list[dict]]:
    """Every change, keyed by `(entity_dim, member)`; `(None, None)` is the model.

    A change whose position names a member present on one side only is
    dropped: that member is an added or removed entity, or sits on a dimension
    `_dims_diff` already reports. A new technology's parameters are not
    *changes* — nothing became anything — but they are exactly what somebody
    needs to see, so `_entity_details` lists them as values instead.
    """
    ins_a, ins_b = a.inputs, b.inputs
    common = {
        str(dim): set(_members(ins_a, str(dim))) & set(_members(ins_b, str(dim)))
        for dim in set(ins_a.dims) | set(ins_b.dims)
        if str(dim) != TIME_DIM
    }
    changes: dict[tuple[str, str | None], list[dict]] = {}

    names = sorted(set(map(str, ins_a.data_vars)) | set(map(str, ins_b.data_vars)))
    for name in names:
        if name in MATRIX_NAMES or name.startswith("__"):
            continue
        raw_a = ins_a[name] if name in ins_a else None
        raw_b = ins_b[name] if name in ins_b else None
        if raw_a is None:
            raw_a = _absent_like(raw_b)
        if raw_b is None:
            raw_b = _absent_like(raw_a)
        xa, xb, changed = _aligned(raw_a, raw_b)
        if not bool(changed.any()):
            continue

        unit = unit_for(
            ins_b if name in ins_b else ins_a, name, declared_units, file_units
        )
        dims = [str(d) for d in changed.dims]
        entity_dim = next((d for d in ENTITY_DIMS if d in dims), None)
        where_dims = [d for d in dims if d != entity_dim and d != TIME_DIM]
        timed = TIME_DIM in dims
        mask = changed.any(TIME_DIM) if timed else changed
        numeric = np.issubdtype(xa.dtype, np.number)

        for position in np.argwhere(np.asarray(mask.values)):
            index = dict(zip([str(d) for d in mask.dims], map(int, position)))
            coords = {d: _label(mask[d].values[i]) for d, i in index.items()}
            if any(coords[d] not in common.get(d, set()) for d in coords):
                continue
            change: dict[str, Any] = {
                "param": name,
                "where": {d: coords[d] for d in where_dims},
                "unit": unit,
            }
            if timed:
                sub = changed.isel(index)
                sa, sb = xa.isel(index), xb.isel(index)
                series: dict[str, Any] = {
                    "changed": int(sub.sum()),
                    "total": int(sub.size),
                }
                if numeric:
                    series["before_sum"] = _sum(sa)
                    series["after_sum"] = _sum(sb)
                change["series"] = series
            else:
                change["before"] = plain(xa.isel(index).values[()])
                change["after"] = plain(xb.isel(index).values[()])
            key = (entity_dim, coords[entity_dim]) if entity_dim else (None, None)
            changes.setdefault(key, []).append(change)
    return changes


def _entity_details(
    model: LoadedModel,
    dim: str,
    name: str,
    field: str,
    declared_units: Mapping[str, str],
    file_units: Mapping[str, str],
) -> list[dict]:
    """What an entity that exists on only one side actually *is*.

    "Added" on its own names a thing without describing it, and the first
    question about a technology that has appeared — or one that has gone — is
    what it was set to. So the values are listed rather than the word alone.

    Values, not changes: nothing became anything here. They are carried in the
    `before`/`after` field the caller names, so one shape serves both, and the
    absent side is genuinely absent rather than a null somebody has to read as
    "was not there".

    Two rules keep the listing readable, and without either it is unusable:

    - **Only where the entity is defined.** Every parameter is dimensioned over
      every technology and every node, so an added technology otherwise reports
      `carrier_in: 0` at the four nodes it does not exist at.
    - **One row per distinct value.** A technology defined at three nodes sets
      the same thing at each, and three identical rows bury the one parameter
      that does differ between them.

    Args:
        field: `"after"` for an entity that appeared, `"before"` for one that went.
    """
    inputs = model.inputs
    if dim not in inputs.dims or name not in _members(inputs, dim):
        return []

    defined = _defined_mask(inputs, dim, name)
    details: list[dict] = []

    for variable in sorted(map(str, inputs.data_vars)):
        if variable in MATRIX_NAMES or variable.startswith("__"):
            continue
        array = inputs[variable]
        if dim not in array.dims:
            continue

        sliced = array.sel({dim: name})
        present = sliced.notnull()
        if TIME_DIM in present.dims:
            present = present.any(TIME_DIM)
        if defined is not None:
            present = present & _reduced_to(defined, present)
        if not bool(present.any()):
            continue

        unit = unit_for(inputs, variable, declared_units, file_units)
        timed = TIME_DIM in sliced.dims
        where_dims = [str(d) for d in present.dims]

        rows = []
        for position in np.argwhere(np.asarray(present.values)) if where_dims else [()]:
            index = dict(zip(where_dims, map(int, position)))
            cell = sliced.isel(index) if index else sliced
            where = {d: _label(present[d].values[i]) for d, i in index.items()}
            if timed:
                summary: dict[str, Any] = {"total": int(cell.sizes[TIME_DIM])}
                if np.issubdtype(cell.dtype, np.number):
                    summary[f"{field}_sum"] = _sum(cell)
                rows.append((where, {"series": summary}))
            else:
                rows.append((where, {field: plain(cell.values[()])}))

        details.extend(_collapsed(variable, unit, rows))

    membership = _membership(model, dim, name)
    if membership is not None:
        details.insert(
            0, {"param": membership[0], "where": {}, "unit": "", field: membership[1]}
        )
    return details


def _collapsed(variable: str, unit: str, rows: list) -> list[dict]:
    """One row per distinct value, keeping the position only when it matters."""
    distinct = {json.dumps(value, sort_keys=True, default=str) for _, value in rows}
    if len(distinct) == 1 and rows:
        return [{"param": variable, "where": {}, "unit": unit, **rows[0][1]}]
    return [
        {"param": variable, "where": where, "unit": unit, **value}
        for where, value in rows
    ]


def _defined_mask(inputs: xr.Dataset, dim: str, name: str) -> xr.DataArray | None:
    """Where this entity exists, as the definition matrix has it."""
    matrix = _matrix_name(inputs)
    if matrix is None or dim not in inputs[matrix].dims:
        return None
    return inputs[matrix].sel({dim: name}).fillna(0).astype(bool)


def _reduced_to(mask: xr.DataArray, target: xr.DataArray) -> xr.DataArray:
    """The mask over the dimensions `target` has, `any`-ing away the rest.

    Older files carry a `carriers` dimension on the matrix that the newer
    `active` array dropped, so a mask can be indexed by more than the parameter
    it is filtering.
    """
    extra = [str(d) for d in mask.dims if d not in target.dims]
    return mask.any(extra) if extra else mask


def _membership(
    model: LoadedModel, dim: str, name: str
) -> tuple[str, list[str]] | None:
    """Where a technology is defined, or what is defined at a node.

    Part of what an entity *is*, and not a parameter — so it is read off the
    definition matrix and shown first, above the values.
    """
    inputs = model.inputs
    if dim == "techs":
        nodes = _defined_nodes(inputs, name)
        return ("nodes", sorted(nodes)) if nodes else None
    if dim == "nodes":
        techs = _defined_techs(inputs, name)
        return ("techs", sorted(techs)) if techs else None
    return None


def _defined_techs(inputs: xr.Dataset, node: str) -> set[str] | None:
    """The techs defined at a node, or None when the file cannot say."""
    return _defined_along(inputs, "nodes", node, "techs")


def _sum(array: xr.DataArray) -> float | None:
    if bool(array.isnull().all()):
        return None
    return plain(float(array.sum(skipna=True)))


# -- entities -----------------------------------------------------------------


def _entities(
    a: LoadedModel,
    b: LoadedModel,
    changes: dict[tuple[str, str | None], list[dict]],
    declared_units: Mapping[str, str],
    file_units: Mapping[str, str],
) -> tuple[list[dict], dict]:
    base_a, base_b = tech_base_techs(a), tech_base_techs(b)

    def kind_of(dim: str, name: str) -> str:
        if dim == "techs" and "transmission" in (base_a.get(name), base_b.get(name)):
            return "link"
        return KIND_OF_DIM[dim]

    summary = {
        kind: dict.fromkeys(("added", "removed", "changed", "unchanged"), 0)
        for kind in KINDS
    }
    entities: list[dict] = []

    for dim in ENTITY_DIMS:
        before, after = set(_members(a.inputs, dim)), set(_members(b.inputs, dim))
        for name in sorted(before | after):
            kind = kind_of(dim, name)
            if name not in after:
                status = "removed"
                listed = _entity_details(
                    a, dim, name, "before", declared_units, file_units
                )
            elif name not in before:
                status = "added"
                listed = _entity_details(
                    b, dim, name, "after", declared_units, file_units
                )
            else:
                listed = list(changes.get((dim, name), []))
                if dim == "techs":
                    listed = _nodes_change(a.inputs, b.inputs, name) + listed
                status = "changed" if listed else "unchanged"
            summary[kind][status] += 1
            if status == "unchanged":
                continue
            entities.append(_entity(kind, name, status, listed))

    model_changes = changes.get((None, None), [])
    model_name = b.name or a.name or "model"
    if model_changes:
        summary["model"]["changed"] += 1
        entities.append(_entity("model", model_name, "changed", model_changes))
    else:
        summary["model"]["unchanged"] += 1

    order = {kind: index for index, kind in enumerate(KINDS)}
    entities.sort(key=lambda entity: (order[entity["kind"]], entity["name"]))
    return entities, summary


def _entity(kind: str, name: str, status: str, changes: list[dict]) -> dict:
    entity = {
        "kind": kind,
        "name": name,
        "status": status,
        "changes": changes[:MAX_CHANGES_PER_ENTITY],
    }
    if len(changes) > MAX_CHANGES_PER_ENTITY:
        entity["truncated"] = len(changes) - MAX_CHANGES_PER_ENTITY
    return entity


def _nodes_change(ins_a: xr.Dataset, ins_b: xr.Dataset, tech: str) -> list[dict]:
    """The one change the definition matrix can express: where a tech is defined."""
    before, after = _defined_nodes(ins_a, tech), _defined_nodes(ins_b, tech)
    if before is None or after is None or before == after:
        return []
    return [
        {
            "param": "nodes",
            "where": {},
            "unit": "",
            "before": sorted(before),
            "after": sorted(after),
        }
    ]


# -- config -------------------------------------------------------------------


def _flatten(value: Any, prefix: str = "") -> dict[str, Any]:
    if isinstance(value, Mapping) and value:
        flat: dict[str, Any] = {}
        for key, item in value.items():
            flat.update(_flatten(item, f"{prefix}.{key}" if prefix else str(key)))
        return flat
    return {prefix: value}


def _config_diff(a: Mapping | None, b: Mapping | None) -> list[dict]:
    flat_a, flat_b = _flatten(a or {}), _flatten(b or {})
    rows = []
    for path in sorted(set(flat_a) | set(flat_b)):
        before, after = flat_a.get(path, _MISSING), flat_b.get(path, _MISSING)
        if before is not _MISSING and after is not _MISSING and same(before, after):
            continue
        rows.append(
            {
                "path": path,
                "before": None if before is _MISSING else plain(before),
                "after": None if after is _MISSING else plain(after),
            }
        )
    return rows
