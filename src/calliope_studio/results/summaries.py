"""Model and configuration summaries.

Plain dictionaries. The v0.2.0 layer returned these as single-column
`object`-dtype DataFrames whose cells held nested dicts and None — a table
shape imposed by the widget that displayed them, not by the data.
"""

import math
from typing import Any


def _jsonable(value: Any) -> Any:
    """Makes a configuration value safe to serialise.

    Configuration carries pydantic models, Paths, enums and `.inf` defaults,
    none of which JSON can represent directly.
    """
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_jsonable(item) for item in value]
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, (str, int, bool)) or value is None:
        return value
    return str(value)


def _field(source, name: str):
    """One named value from a mapping or an object, whichever it is.

    `runtime` and `config` are plain dicts now that the reader parses them out of
    the file rather than letting Calliope build its schema objects. A bare
    `getattr` finds nothing at all in a dict — silently, returning the default —
    so every fact on the summary panel would have read as blank.
    """
    if isinstance(source, dict):
        return source.get(name)
    return getattr(source, name, None)


def model_summary(handle) -> dict:
    """Headline facts about a solved model."""
    model = handle.model
    dataset = handle.dataset
    runtime = getattr(model, "runtime", None)

    def dimension(name: str) -> int | None:
        return int(dataset[name].size) if name in dataset.coords else None

    return _jsonable(
        {
            "name": handle.name,
            "scenario": _field(runtime, "scenario"),
            "applied_overrides": _field(runtime, "applied_overrides"),
            "calliope_version": _field(runtime, "calliope_version_initialised"),
            "termination_condition": _field(runtime, "termination_condition"),
            "techs": dimension("techs"),
            "nodes": dimension("nodes"),
            "carriers": dimension("carriers"),
            "timesteps": dimension("timesteps"),
        }
    )


def _config_section(handle, section: str) -> dict:
    config = getattr(handle.model, "config", None)
    block = _field(config, section)
    if block is None:
        return {}
    dump = block.model_dump() if hasattr(block, "model_dump") else dict(block)
    return _jsonable(dump)


def summaries(handle) -> dict:
    """Everything the summary view shows, in one response."""
    return {
        "model": model_summary(handle),
        "build_config": _config_section(handle, "build"),
        "solve_config": _config_section(handle, "solve"),
        "init_config": _config_section(handle, "init"),
    }
