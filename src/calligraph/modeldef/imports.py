"""The `import:` graph and the conceptual component tree across it.

A Calliope model is spread over several YAML files chained by `import:` lists.
The editor needs two views of that: the raw file graph, and a merged picture of
which sections and named entries exist and which file defines each.
"""

from pathlib import Path
from typing import Any

from calligraph.modeldef.yaml_io import load_quietly

#: Sections shown in the component tree, in display order.
TREE_SECTIONS = (
    "config",
    "data_tables",
    "techs",
    "nodes",
    "links",
    "templates",
    "overrides",
    "scenarios",
)

#: Sections whose entries are bare names rather than objects with metadata.
FLAT_SECTIONS = frozenset({"data_tables", "overrides", "scenarios"})


def find_model_yaml(base: Path) -> Path | None:
    """Finds the model's entry-point file at the workspace root."""
    for name in ("model.yaml", "model.yml"):
        candidate = base / name
        if candidate.is_file():
            return candidate
    return None


def collect_imports(
    path: Path, base: Path, visited: set[Path] | None = None
) -> list[tuple[Path, Path]]:
    """Follows `import:` lists recursively.

    Args:
        path: File to start from.
        base: Workspace root; imports resolving outside it are ignored.
        visited: Guards against import cycles.

    Returns:
        (parent, child) edges, absolute and within `base`.
    """
    if visited is None:
        visited = set()
    if path in visited:
        return []
    visited.add(path)

    document = load_quietly(path)
    if not isinstance(document, dict):
        return []

    imports = document.get("import") or []
    if not isinstance(imports, list):
        imports = [imports]

    edges: list[tuple[Path, Path]] = []
    for entry in imports:
        if not entry:
            continue
        child = (path.parent / str(entry)).resolve()
        if not child.is_relative_to(base) or not child.is_file():
            continue
        edges.append((path, child))
        edges.extend(collect_imports(child, base, visited))
    return edges


def _reachable_files(base: Path) -> list[Path]:
    """Every file reachable from the model root, root first, deduplicated."""
    root = find_model_yaml(base)
    if root is None:
        return []
    files = [root] + [child for _, child in collect_imports(root, base)]
    seen: set[Path] = set()
    unique = []
    for path in files:
        if path not in seen:
            seen.add(path)
            unique.append(path)
    return unique


def import_graph(base: Path) -> dict:
    """The `import:` DAG, as nodes and edges for the frontend's graph view."""
    root = find_model_yaml(base)
    if root is None:
        return {"nodes": [], "edges": []}

    nodes: dict[str, dict] = {}

    def add(path: Path, node_type: str = "file") -> str:
        relative = str(path.relative_to(base))
        if relative not in nodes:
            nodes[relative] = {"id": relative, "label": relative, "type": node_type}
        return relative

    add(root, "root")
    edges = [
        {"source": add(parent), "target": add(child)}
        for parent, child in collect_imports(root, base)
    ]
    return {"nodes": list(nodes.values()), "edges": edges}


def component_tree(base: Path) -> dict:
    """Merged view of which sections and entries exist, and where.

    The first file to define a section owns it; entries accumulate across files,
    first definition winning. Every section has the same shape — `{file,
    entries}` with entries as objects — rather than the Django version's mix of
    bare strings and objects depending on section.
    """
    tree: dict[str, Any] = {}

    for path in _reachable_files(base):
        document = load_quietly(path)
        if not isinstance(document, dict):
            continue
        relative = str(path.relative_to(base))

        for section in TREE_SECTIONS:
            if section not in document:
                continue

            if section == "config":
                tree.setdefault("config", {"file": relative})
                continue

            block = document[section]
            if not isinstance(block, dict):
                continue

            node = tree.setdefault(section, {"file": relative, "entries": []})
            existing = {entry["name"] for entry in node["entries"]}

            for name in block:
                if name in existing:
                    continue
                existing.add(name)
                entry: dict[str, Any] = {"name": str(name), "file": relative}
                if section not in FLAT_SECTIONS:
                    value = block.get(name)
                    template = (
                        value.get("template") if isinstance(value, dict) else None
                    )
                    if template:
                        entry["template"] = template
                node["entries"].append(entry)

    return tree
