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
"""

import math
from functools import lru_cache
from typing import Any

#: Math files whose parameter definitions are merged, in order. Later files
#: describe optional modes and only add to the vocabulary.
MATH_SOURCES = ("base", "milp", "operate", "spores", "storage_inter_cluster")

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


def _parameter_registry() -> dict:
    """Per-parameter metadata merged across Calliope's built-in math files."""
    from calliope.preprocess import model_math

    all_math = model_math.initialise_math()

    registry: dict[str, dict] = {section: {} for section in REGISTRY_SECTIONS}
    for source in MATH_SOURCES:
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
    for source in MATH_SOURCES:
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
    """
    import calliope

    schemas = _json_schemas()
    payload = dict(schemas["model"])
    payload["x-calliope"] = {
        "version": calliope.__version__,
        "schemas": schemas,
        "registry": _parameter_registry(),
    }
    return payload
