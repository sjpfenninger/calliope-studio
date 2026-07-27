"""Which parameters come from CSV data tables, and how they are indexed.

The structured editors use this to show "this value comes from `cost_parameters`"
rather than offering an editable field whose value a data table will override at
build time.

**Calliope reads the tables.** `calliope.preprocess.data_tables.DataTable` is the
same class the model itself is built from, so `rows`, `columns`, `select`, `drop`,
`add_dims` and `rename_dims` all mean exactly what they mean in a real run. The
hand-written reader this replaced handled the first three and silently ignored the
rest, which was not a theoretical gap:

- `add_dims: {parameters: sink_use_equals}` — how `urban_scale` and
  `examples/model_nld-NUTS3-v1` declare their timeseries — produced *no*
  provenance at all, so the editor offered an editable field for a value the table
  overwrites. That is the exact failure this module exists to prevent.
- multi-level `rows` were collapsed onto the entity dimension, so a
  `(nodes, techs)` parameter was reported as a parameter *of the node*, valued from
  whichever tech's row happened to come last. `NLD111` was told it had
  `flow_cap_max = 0.0058`.
- `drop` names a dimension *level*; it was compared against parameter names and
  cell values, which worked by luck on `drop: comment`.

What Calliope does not record is **which table** a value came from — the
`(data_tables, name)` string exists only in its error messages — so that part is
still ours, and it is the only reason this module reads the tables itself rather
than asking a resolved model.

Each parameter is reported with its `dims`, which is what makes an honest answer
possible: a parameter indexed on more than the entity is not a parameter *of* that
entity, and gets no value.
"""

import math
from pathlib import Path
from typing import Any

from calliope_studio.modeldef.imports import find_model_yaml
from calliope_studio.modeldef.paths import yaml_files
from calliope_studio.modeldef.yaml_io import load_quietly

#: Dimensions that make a parameter time-varying rather than scalar.
TIME_DIMS = ("timesteps",)

#: How many resolved table readings to keep. Reading a model's tables means
#: reading its CSVs, which for hourly profiles is most of a second — and the
#: editors ask for both `tech` and `node` provenance on every load.
CACHE_SIZE = 4


def _as_list(value: Any) -> list:
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    return list(value)


def _scalar(value: Any) -> Any:
    """Converts a pandas/numpy scalar to something JSON can carry."""
    if hasattr(value, "item"):  # numpy scalar
        try:
            value = value.item()
        except (AttributeError, ValueError):
            return None
    if isinstance(value, float):
        return None if (math.isnan(value) or math.isinf(value)) else value
    return value


def collect_data_tables(yaml_path: Path) -> list[tuple[str, dict, Path]]:
    """Finds every `data_tables:` entry in a file, including inside overrides.

    Deliberately a superset of what is active: `snapshot` needs every CSV the model
    could refer to under any scenario, because a snapshot missing one is not a
    buildable model. Provenance wants the opposite — see `active_tables`.

    Returns:
        (table name, config, directory the paths in it are relative to) triples.
    """
    document = load_quietly(yaml_path)
    if not isinstance(document, dict):
        return []

    found: list[tuple[str, dict, Path]] = []
    directory = yaml_path.parent

    def gather(mapping: Any) -> None:
        if not isinstance(mapping, dict):
            return
        tables = mapping.get("data_tables")
        if isinstance(tables, dict):
            for name, config in tables.items():
                if isinstance(config, dict):
                    found.append((str(name), dict(config), directory))

    gather(document)
    for override in (document.get("overrides") or {}).values():
        gather(override)
    return found


def active_tables(base: Path) -> tuple[Path | None, dict[str, dict]]:
    """The `data_tables:` the base model actually uses, in Calliope's own order.

    From the assembled definition, so overrides — which are not applied unless a
    scenario selects them — do not contribute. The previous reader took every
    table in every YAML file *including* inside `overrides:`, which meant a table
    belonging to an unselected scenario supplied provenance, and (through
    `geo.coordinates_from_tables`) node positions on the map.

    Returns:
        The model definition path the table paths are relative to, and the tables.
    """
    root = Path(base).resolve()
    model_yaml = find_model_yaml(root)
    if model_yaml is None:
        return None, {}

    from calliope_studio.modeldef.entities import assembled

    definition = assembled(root)
    if definition is not None:
        tables = definition.sections.get("data_tables")
        if isinstance(tables, dict):
            return model_yaml, {
                str(name): dict(config)
                for name, config in tables.items()
                if isinstance(config, dict)
            }

    # Assembly failed — a model mid-edit. Fall back to reading the files, which
    # cannot tell an active table from one inside an override.
    tables = {}
    for path in yaml_files(root):
        for name, config, _ in collect_data_tables(path):
            tables.setdefault(name, config)
    return model_yaml, tables


def _fingerprint(model_yaml: Path, tables: dict[str, dict]) -> tuple:
    """Enough to know a cached reading is still current: the CSVs it read."""
    entries = [str(model_yaml)]
    for name, config in tables.items():
        for value in _as_list(config.get("data")):
            path = (model_yaml.parent / str(value)).resolve()
            try:
                stat = path.stat()
            except OSError:
                entries.append(f"{name}:{value}:missing")
                continue
            entries.append(f"{name}:{value}:{stat.st_mtime_ns}:{stat.st_size}")
    return tuple(entries)


#: `{fingerprint: {parameter: {"source", "dims", "values"}}}`, newest last.
_cache: dict[tuple, dict] = {}


def _read_tables(base: Path) -> dict[str, dict]:
    """Every parameter the active tables supply, with its dims and its values.

    Returns:
        `{parameter: {source, dims, values}}` where `values` maps a dimension
        member tuple to a scalar — read once per parameter, sliced per entity by
        `data_table_params`.
    """
    model_yaml, tables = active_tables(base)
    if model_yaml is None or not tables:
        return {}

    key = _fingerprint(model_yaml, tables)
    cached = _cache.get(key)
    if cached is not None:
        return cached

    from calliope.preprocess.data_tables import DataTable

    found: dict[str, dict] = {}
    for name, config in tables.items():
        try:
            table = DataTable(name, config, model_definition_path=str(model_yaml))
        except Exception:
            # A malformed or half-written table must not break the whole response;
            # the editor simply shows no provenance for it. Calliope raises here
            # for real reasons — a missing `parameters` dimension, a protected
            # parameter — and `validate` is what reports those.
            continue
        for parameter, array in table.dataset.data_vars.items():
            # Later tables win, matching how Calliope merges them into the model.
            found[str(parameter)] = {
                "source": name,
                "dims": [str(dim) for dim in array.dims],
                "array": array,
            }

    _cache[key] = found
    while len(_cache) > CACHE_SIZE:
        _cache.pop(next(iter(_cache)))
    return found


def data_table_params(base: Path, kind: str) -> dict:
    """What the data tables say about each technology, or each node.

    A parameter is reported for an entity when it is indexed on that entity's
    dimension. It gets a `value` when that leaves exactly one number — the entity
    dimension alone, or alongside dimensions with a single member each, which is
    how a one-cost-class model's `cost_flow_cap` looks. Otherwise the honest answer
    is which dimensions it spans, and the editor says that rather than picking one
    of the numbers and presenting it as the value.

    Args:
        base: Workspace root.
        kind: `"tech"` or `"node"`.
    """
    entity_dim = "techs" if kind == "tech" else "nodes"

    merged: dict[str, dict[str, dict]] = {}
    for parameter, found in _read_tables(base).items():
        dims = found["dims"]
        if entity_dim not in dims:
            continue
        array = found["array"]
        others = [dim for dim in dims if dim != entity_dim]
        time_varying = any(dim in TIME_DIMS for dim in others)

        try:
            members = [str(value) for value in array.coords[entity_dim].values]
        except (KeyError, AttributeError):
            continue

        # A dimension with one member does not make the value ambiguous, so it can
        # still be shown — qualified by which member it is.
        index = {}
        if not time_varying:
            for dim in others:
                values = array.coords.get(dim)
                if values is not None and values.size == 1:
                    index[dim] = str(values.values.reshape(-1)[0])
        singular = len(index) == len(others)

        for member in members:
            info: dict[str, Any] = {
                "value": None,
                "time_varying": time_varying,
                "source": found["source"],
                "dims": others,
            }
            if index:
                info["index"] = index
            if singular:
                selection = array.sel({entity_dim: member, **index})
                value = _scalar(selection.values.reshape(-1)[0])
                if value is None:
                    # Not defined for this member: an absent cell, not a value.
                    continue
                info["value"] = value
            merged.setdefault(member, {})[parameter] = info

    return {"kind": kind, "params": merged}
