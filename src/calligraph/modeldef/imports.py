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
#:
#: `overrides` and `scenarios` used to be here. They now carry a summary — how
#: many settings an override makes, and which overrides a scenario composes — so
#: that the explorer says something useful before anything is opened.
FLAT_SECTIONS = frozenset({"data_tables"})


def find_model_yaml(base: Path) -> Path | None:
    """Finds the model's entry-point file at the workspace root.

    Resolves `base` first: imports are followed by resolving each entry against
    its parent and checking it stays inside the workspace, and a relative base
    would fail that check for every one of them.
    """
    root = Path(base).resolve()
    for name in ("model.yaml", "model.yml"):
        candidate = root / name
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


def reachable_files(base: Path) -> list[Path]:
    """Every file reachable from the model root, root first, deduplicated."""
    base = Path(base).resolve()
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


def scenario_names(base: Path) -> set[str]:
    """Every name `scenario=` will accept, across the import graph.

    Calliope takes either a scenario name or a comma-joined list of override
    names in the same argument, so both sections count. Collected up front so a
    typo can be reported immediately, rather than costing a subprocess start, a
    Calliope import and a stack trace before saying "no such scenario".
    """
    names: set[str] = set()
    for path in reachable_files(Path(base).resolve()):
        document = load_quietly(path)
        if not isinstance(document, dict):
            continue
        for section in ("scenarios", "overrides"):
            block = document.get(section)
            if isinstance(block, dict):
                names.update(str(name) for name in block)
    return names


def import_graph(base: Path) -> dict:
    """The `import:` DAG, as nodes and edges for the frontend's graph view."""
    base = Path(base).resolve()
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


def _summarise(section: str, value: Any) -> dict:
    """Whatever makes an entry worth looking at before it is opened.

    An override named `spores` says nothing on its own; "9 settings" says whether
    it is a tweak or a rewrite. A scenario is *only* a list of override names, so
    showing them is showing the whole thing.
    """
    if section == "overrides":
        from calligraph.modeldef.overrides import flatten

        return {"setting_count": len(flatten(value))} if isinstance(value, dict) else {}

    if section == "scenarios":
        if isinstance(value, list):
            return {"overrides": [str(item) for item in value]}
        # A single override name is accepted where a list is expected.
        return {"overrides": [str(value)]} if value else {}

    return {}


def component_tree(base: Path) -> dict:
    """Merged view of which sections and entries exist, and where.

    The first file to define a section owns it; entries accumulate across files,
    first definition winning. Every section has the same shape — `{file,
    entries}` with entries as objects — rather than the Django version's mix of
    bare strings and objects depending on section.
    """
    from calligraph.modeldef.entities import transmission_techs

    base = Path(base).resolve()
    tree: dict[str, Any] = {}

    # Transmission technologies are shown as "links" rather than mixed in with
    # everything else: they are the only entries that connect two nodes, and
    # they are what the map draws. Deciding which they are needs the whole
    # import graph, because `base_tech` usually comes from a template.
    links = transmission_techs(base)

    for path in reachable_files(base):
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

            for name in block:
                # A transmission tech lives under `techs:` in the file but
                # belongs under "links" in the tree; both open the same file and
                # the same YAML section.
                target = (
                    "links" if section == "techs" and str(name) in links else section
                )
                node = tree.setdefault(target, {"file": relative, "entries": []})
                if any(entry["name"] == str(name) for entry in node["entries"]):
                    continue

                entry: dict[str, Any] = {"name": str(name), "file": relative}
                if target not in FLAT_SECTIONS:
                    value = block.get(name)
                    template = (
                        value.get("template") if isinstance(value, dict) else None
                    )
                    if template:
                        entry["template"] = template
                    if target == "links" and isinstance(value, dict):
                        for key in ("link_from", "link_to"):
                            if value.get(key):
                                entry[key] = str(value[key])
                    entry.update(_summarise(target, value))
                node["entries"].append(entry)

    # A `techs:` section containing nothing but links would otherwise leave an
    # empty group in the explorer.
    if tree.get("techs") and not tree["techs"]["entries"]:
        del tree["techs"]

    return tree
