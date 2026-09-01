"""Machine-readable descriptions of what a valid Calliope model looks like.

Generated from the *installed* Calliope rather than checked into the repository,
so it can never drift from the version actually validating and running models.
Cached for the process lifetime; regenerating means restarting the server, which
is also when a Calliope upgrade would take effect.

Two complementary sources, because neither is sufficient alone:

- **JSON Schema** from Calliope's pydantic models gives structure, and drives
  the frontend's recursive form renderer.
- **The math parameter registry** (`calliope/math/base.yaml`) gives per-parameter
  titles, descriptions, units and defaults. This matters because the tech and
  node models are declared `extra: "allow"` and enumerate no parameters at all,
  so JSON Schema alone tells the editor nothing about what a technology may
  contain.

The JSON Schema needs widening before it can be shown to anyone, because it is a
*validation-mode* schema and Calliope's shorthands live in `mode="before"` field
validators, which pydantic does not describe. `dims: costs`, `index: monetary`
and `techs: {demand_power:}` are all real Calliope, used throughout its own
example models, and all three were reported as errors — so the editor painted
Calliope's own syntax red. `_widened` puts them back; `tests/test_schema.py`
holds the line by validating every file of both example models against what this
module serves.
"""

import math
from functools import lru_cache
from typing import Any

from calliope_studio.modeldef.mathdef import builtin_math_names

#: Sections of the math registry that describe model inputs, and so are useful
#: for annotating editor fields. Constraints and variables are not.
REGISTRY_SECTIONS = ("parameters", "lookups", "dimensions")

#: Sections that declare a `unit:`. Wider than `REGISTRY_SECTIONS` because a
#: results chart plots variables and global expressions, which are not editor
#: fields and so are deliberately absent from the registry.
UNIT_SECTIONS = ("parameters", "lookups", "variables", "global_expressions")


def _jsonable(value: Any) -> Any:
    """Makes a value JSON-safe.

    Calliope uses `.inf` for unbounded defaults, which JSON cannot represent.
    """
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, (str, int, bool)) or value is None:
        return value
    return str(value)


def _json_schemas() -> dict:
    from calliope import schemas
    from calliope.schemas import data_table_schema, math_schema

    return {
        "config": schemas.CalliopeConfig.model_no_ref_schema(),
        "model": schemas.CalliopeModelDef.model_no_ref_schema(),
        "math": math_schema.CalliopeBuildMath.model_no_ref_schema(),
        "data_table": data_table_schema.CalliopeDataTable.model_no_ref_schema(),
    }


#: What `IndexedData.listify_index` turns a bare value into a list of.
_INDEX_SCALARS = ({"type": "string"}, {"type": "integer"}, {"type": "number"})


def _alternatives(schema: dict) -> list:
    """The branches a schema already accepts, whether or not it is an `anyOf`."""
    branches = schema.get("anyOf")
    return list(branches) if isinstance(branches, list) else [schema]


def _accepts(schema: dict, type_name: str) -> bool:
    """Whether a value of this JSON type is already permitted.

    Every widening below is guarded on this, so a Calliope that grows a
    `json_schema_input_type` for one of its before-validators makes the
    corresponding rule a no-op rather than adding a duplicate branch.
    """
    return any(branch.get("type") == type_name for branch in _alternatives(schema))


def _widen_indexed_data(schema: dict) -> None:
    """Restores the scalar `dims`/`index` shorthands, in place.

    Recognised structurally — an object declaring all three of `data`, `dims` and
    `index` is `IndexedData` or its `IndexedTechNodeParam` subclass, which
    `model_no_ref_schema` inlines at every use site. Keying on the shape rather
    than on the title means a docstring edit upstream cannot silently turn this
    off; `tests/test_schema.py` notices if a rename does.
    """
    dims, index = schema["dims"], schema["index"]

    # `listify_dims` wraps anything that is not already a list.
    if not _accepts(dims, "string"):
        schema["dims"] = _annotated(dims, [*_alternatives(dims), {"type": "string"}])

    # `listify_index` accepts a bare value, or a flat list of them, as well as
    # the list-of-lists the field declares.
    if not _accepts(index, "string"):
        schema["index"] = _annotated(
            index,
            [
                *_alternatives(index),
                {"type": "array", "items": {"anyOf": list(_INDEX_SCALARS)}},
                *(dict(scalar) for scalar in _INDEX_SCALARS),
            ],
        )


def _annotated(original: dict, branches: list) -> dict:
    """An `anyOf` keeping the title and description the editor displays."""
    widened: dict[str, Any] = {"anyOf": branches}
    for key in ("title", "description"):
        if key in original:
            widened[key] = original[key]
    return widened


def _is_techs_mapping(schema: dict) -> bool:
    """Whether this is a `techs:` block — Calliope's, or a node's."""
    patterns = schema.get("patternProperties")
    if not isinstance(patterns, dict):
        return False
    return any(
        "base_tech" in (branch.get("properties") or {})
        for entry in patterns.values()
        if isinstance(entry, dict)
        for branch in _alternatives(entry)
        if isinstance(branch, dict)
    )


def _widened(node: Any) -> Any:
    """The served schema, widened to what Calliope's validators actually accept.

    Both rules are additive and idempotent, and neither loosens anything a
    before-validator does not already coerce: a genuine mistake — a `techs`
    block that is a string, a `latitude` that is a word — is still an error.
    """
    if isinstance(node, list):
        return [_widened(item) for item in node]
    if not isinstance(node, dict):
        return node

    widened = {key: _widened(value) for key, value in node.items()}

    properties = widened.get("properties")
    if isinstance(properties, dict) and {"data", "dims", "index"} <= properties.keys():
        _widen_indexed_data(properties)

    # `CalliopeTechs.no_none_entries` accepts an empty technology (`demand_power:`)
    # and an empty block (`techs:`), which is how every example model writes a
    # technology it does not override.
    if _is_techs_mapping(widened):
        patterns = widened["patternProperties"]
        for name, entry in patterns.items():
            if isinstance(entry, dict) and not _accepts(entry, "null"):
                patterns[name] = {"anyOf": [*_alternatives(entry), {"type": "null"}]}
        if not _accepts(widened, "null"):
            return {"anyOf": [widened, {"type": "null"}]}

    return widened


def _parameter_registry() -> dict:
    """Per-parameter metadata merged across Calliope's built-in math files."""
    from calliope.preprocess import model_math

    all_math = model_math.initialise_math()

    registry: dict[str, dict] = {section: {} for section in REGISTRY_SECTIONS}
    for source in builtin_math_names():
        block = all_math.get(source) or {}
        for section in REGISTRY_SECTIONS:
            for name, definition in (block.get(section) or {}).items():
                # First definition wins: `base` is authoritative, later modes
                # only contribute names it does not already define.
                registry[section].setdefault(str(name), _jsonable(dict(definition)))
    return registry


@lru_cache(maxsize=1)
def component_units() -> dict[str, str]:
    """Each Calliope component's declared unit, as the math states it.

    A *generalised* quantity — `energy`, `power`, `cost`, and LaTeX composites
    such as `$\\frac{\\text{cost}}{\\text{hour}}$` — never a real one: Calliope
    has no idea whether a model's flows are in kWh or GWh. Turning that into
    "GWh" is the user's to say and the frontend's to render, so the strings are
    passed on exactly as written, inconsistencies and all.

    Solved arrays carry the same value in `attrs["unit"]`, but only patchily:
    the sample `urban_scale` results have it on 23 of 34 *inputs* and none of
    their 24 results, while the older flat files have it the other way round.
    This is the source that answers for every name Calliope itself defines;
    attrs are what answer for math a user wrote themselves.
    """
    from calliope.preprocess import model_math

    all_math = model_math.initialise_math()

    units: dict[str, str] = {}
    for source in builtin_math_names():
        block = all_math.get(source) or {}
        for section in UNIT_SECTIONS:
            for name, definition in (block.get(section) or {}).items():
                unit = (definition or {}).get("unit")
                # First definition wins, as in `_parameter_registry`: `base` is
                # authoritative and the mode files mostly re-declare a component
                # to add bounds, leaving `unit` unset.
                if unit:
                    units.setdefault(str(name), str(unit))
    return units


@lru_cache(maxsize=1)
def calliope_schemas() -> dict:
    """The full schema payload served to the frontend.

    The top level keeps the shape the Monaco YAML integration expects — a JSON
    Schema for the model definition — with the additional schemas and the
    parameter registry alongside it, so consumers can adopt them incrementally.

    `model` is deliberately absent from the sibling map: it *is* the top level,
    so including it sent the same 11 KB twice in an 83 KB response. It also
    aliased, when the copy taken here was a shallow one — the two shared their
    nested `properties`, and a mutation of either would have reached both.
    """
    import calliope

    schemas = _json_schemas()
    payload = _widened(schemas["model"])
    payload["x-calliope"] = {
        "version": calliope.__version__,
        "schemas": {k: v for k, v in schemas.items() if k != "model"},
        "registry": _parameter_registry(),
    }
    return payload
