"""Which parameters come from CSV data tables, and whether they vary over time.

The structured editors use this to show "this value comes from `cost_parameters`"
rather than offering an editable field whose value a data table will override at
build time.

A `data_tables:` entry declares which dimensions index the CSV's rows and
columns. Two cases matter:

- the entity dimension (`techs`/`nodes`) indexes **rows**, so each cell is a
  scalar parameter value we can read directly;
- the entity dimension is a **column header level**, which means the rows are
  timesteps, so the parameter is time-varying and only its existence matters.

Only the header rows are read in the second case, which keeps this cheap on
8760-row profiles.
"""

import math
from pathlib import Path
from typing import Any

from calligraph.modeldef.paths import yaml_files
from calligraph.modeldef.yaml_io import load_quietly


def _as_list(value: Any) -> list:
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    return list(value)


def _scalar(value: Any) -> Any:
    """Converts a pandas/numpy scalar to something JSON can carry."""
    if isinstance(value, float):
        return None if (math.isnan(value) or math.isinf(value)) else value
    if hasattr(value, "item"):  # numpy scalar
        return value.item()
    return value


def _is_nan(value: Any) -> bool:
    try:
        return math.isnan(float(value))
    except (TypeError, ValueError):
        return False


def collect_data_tables(yaml_path: Path) -> list[tuple[str, dict, Path]]:
    """Finds every `data_tables:` entry in a file, including inside overrides.

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


def extract_entity_params(
    config: dict, csv_path: Path, entity_dim: str
) -> dict[str, dict[str, dict]]:
    """Reads per-entity parameters out of one data table.

    Args:
        config: The `data_tables:` entry.
        csv_path: The CSV it refers to.
        entity_dim: `"techs"` or `"nodes"`.

    Returns:
        `{entity: {parameter: {value, time_varying}}}`.
    """
    import pandas as pd

    rows = _as_list(config.get("rows"))
    columns = _as_list(config.get("columns"))
    dropped = _as_list(config.get("drop"))

    if entity_dim not in rows + columns:
        return {}

    if entity_dim in rows:
        # Timesteps in the rows means every cell is part of a profile, not a
        # scalar parameter, so there is nothing to surface.
        if "timesteps" in rows:
            return {}

        header: Any = list(range(len(columns))) if len(columns) > 1 else 0
        index_col: Any = list(range(len(rows))) if len(rows) > 1 else 0
        frame = pd.read_csv(csv_path, header=header, index_col=index_col)

        if len(columns) > 1:
            keep = next((i for i, name in enumerate(columns) if name not in dropped), 0)
            frame.columns = frame.columns.get_level_values(keep)
        if len(rows) > 1 and hasattr(frame.index, "get_level_values"):
            frame.index = frame.index.get_level_values(rows.index(entity_dim))

        result: dict[str, dict[str, dict]] = {}
        for entity, row in frame.iterrows():
            params = {
                str(name): {"value": _scalar(value), "time_varying": False}
                for name, value in row.items()
                if str(name) not in dropped and not _is_nan(value)
            }
            if params:
                result[str(entity)] = params
        return result

    # Entity is a column header level: rows are timesteps, so read headers only.
    if "parameters" not in columns:
        return {}
    try:
        headers = pd.read_csv(csv_path, header=None, nrows=len(columns), index_col=0)
    except (OSError, ValueError):
        return {}

    entity_level = columns.index(entity_dim)
    param_level = columns.index("parameters")
    if entity_level >= len(headers) or param_level >= len(headers):
        return {}

    result = {}
    for position in range(len(headers.columns)):
        entity = str(headers.iloc[entity_level, position])
        parameter = str(headers.iloc[param_level, position])
        if parameter in dropped or entity in dropped:
            continue
        result.setdefault(entity, {}).setdefault(
            parameter, {"value": None, "time_varying": True}
        )
    return result


def data_table_params(base: Path, kind: str) -> dict:
    """Merges data-table provenance across every YAML file in a workspace.

    A scalar value always wins over a time-varying marker, and a later scalar
    wins over an earlier one, mirroring how Calliope resolves them.

    Args:
        base: Workspace root.
        kind: `"tech"` or `"node"`.
    """
    entity_dim = "techs" if kind == "tech" else "nodes"
    root = base.resolve()

    merged: dict[str, dict[str, dict]] = {}
    for yaml_path in yaml_files(root):
        for table_name, config, directory in collect_data_tables(yaml_path):
            data_field = config.get("data")
            if not data_field:
                continue
            csv_path = (directory / str(data_field)).resolve()
            if not csv_path.is_relative_to(root) or not csv_path.is_file():
                continue
            try:
                extracted = extract_entity_params(config, csv_path, entity_dim)
            except Exception:
                # A malformed or half-written table should not break the whole
                # response; the editor simply shows no provenance for it.
                continue

            for entity, params in extracted.items():
                target = merged.setdefault(entity, {})
                for parameter, info in params.items():
                    existing = target.get(parameter)
                    # First writer wins among time-varying markers; any scalar
                    # supersedes them, and a later scalar supersedes an earlier.
                    if existing is None or not info["time_varying"]:
                        target[parameter] = {**info, "source": table_name}

    return {"kind": kind, "params": merged}
