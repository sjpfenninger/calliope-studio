"""The `import:` graph and the conceptual component tree across it.

A Calliope model is spread over several YAML files chained by `import:` lists.
The editor needs two views of that: the raw file graph, and a merged picture of
which sections and named entries exist and which file defines each.
"""

from pathlib import Path
from typing import Any

from calliope_studio.modeldef.yaml_io import load_quietly

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
        try:
            if candidate.is_file():
                return candidate
        except OSError:
            # `is_file()` looks like it cannot raise, and mostly cannot:
            # pathlib swallows ENOENT, ENOTDIR, EBADF and ELOOP. It does *not*
            # swallow EACCES, so a directory the process cannot traverse raises
            # straight out of what is only a probe. `routes/browse.py` calls
            # this on every child of whatever the user is looking at, so one
            # unreadable folder in a home directory made the model picker 500 —
            # and on a Linux CI runner, browsing `/` hits root-only
            # `/lost+found` every time.
            #
            # A directory we cannot read is not a model, which is the whole
            # question being asked — but that is a statement about *this*
            # candidate. Returning from the middle of a two-name loop also
            # abandoned the `model.yml` probe on an `EACCES` reading
            # `model.yaml`, which is a different claim and a wrong one.
            continue
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


#: Node types in precedence order, most specific first.
#:
#: A file can be reached more than one way, and what it *is* beats how it was
#: reached: `urban_scale`'s `additional_math.yaml` would be typed by whichever
#: route the walk happened to visit first, which is the kind of order-dependent
#: answer this project keeps having to unpick. `filekinds.classify` resolves the
#: same collision the same way and for the same reason.
_TYPE_RANK = {"root": 0, "math": 1, "data_table": 2, "file": 3, "missing": 4}

#: What each of `snapshot.Reference`'s kinds draws as.
_KIND_TYPE = {"import": "file", "math": "math", "data_table": "data_table"}


def import_graph(base: Path) -> dict:
    """Every file the model names, and what names it.

    Three routes, not one. `import:` chains are only the first: `urban_scale`
    reaches `additional_math.yaml` through `config.init.math_paths`, which the
    import chain structurally cannot see, and every model's real numbers are in
    the CSVs behind `data_tables[*].table`. All three come from
    `snapshot.walk_references`, which is also what a run snapshot is captured
    from — so the graph shows exactly the set a run would freeze rather than a
    subset of it.

    A reference that does not resolve is drawn as a `missing` node rather than
    dropped. A typo in a `table:` path is otherwise silent until it surfaces as
    a Calliope traceback minutes into a run.
    """
    # Local: `snapshot` imports this module, so the dependency only goes one way
    # at module level. Same shape as `component_tree` below.
    from calliope_studio.modeldef.snapshot import walk_references

    base = Path(base).resolve()
    root = find_model_yaml(base)
    if root is None:
        return {"nodes": [], "edges": []}

    nodes: dict[str, dict] = {}

    def add(node_id: str, label: str, node_type: str) -> str:
        node = nodes.get(node_id)
        if node is None:
            nodes[node_id] = {"id": node_id, "label": label, "type": node_type}
        elif _TYPE_RANK[node_type] < _TYPE_RANK[node["type"]]:
            node["type"] = node_type
        return node_id

    def add_file(path: Path, node_type: str = "file") -> str:
        relative = path.relative_to(base).as_posix()
        return add(relative, relative, node_type)

    add_file(root, "root")

    # Keyed on the pair rather than on (pair, kind): two edges between one pair
    # draw identical geometry, so a second is invisible ink in a bigger payload.
    edges: dict[tuple[str, str], dict] = {}

    def connect(source: str, target: str, kind: str) -> None:
        edge = edges.get((source, target))
        if edge is None:
            edges[(source, target)] = {"source": source, "target": target, "kind": kind}
        elif _TYPE_RANK[_KIND_TYPE[kind]] < _TYPE_RANK[_KIND_TYPE[edge["kind"]]]:
            # Drawn like the node it lands on, which took the same precedence.
            edge["kind"] = kind

    for reference in walk_references(base):
        resolved = reference.target.resolve()
        inside = resolved.is_relative_to(base)
        if inside and resolved.is_file():
            target = add_file(resolved, _KIND_TYPE[reference.kind])
        else:
            # Keyed on where it was looked for, relative to the model where it
            # can be, so two files each naming a different missing `costs.csv`
            # stay two nodes; labelled with what was written, which is what the
            # user has to fix. Neither carries an absolute path into the
            # dialog: the id used to, while the comment beside it claimed the
            # label was the only spelling that did not.
            where = resolved.relative_to(base).as_posix() if inside else reference.raw
            target = add(f"missing:{where}", reference.raw, "missing")
            nodes[target]["reason"] = "not found" if inside else "outside the workspace"
        connect(add_file(reference.source), target, reference.kind)

    return {"nodes": list(nodes.values()), "edges": list(edges.values())}


def _summarise(section: str, value: Any) -> dict:
    """Whatever makes an entry worth looking at before it is opened.

    An override named `spores` says nothing on its own; "9 settings" says whether
    it is a tweak or a rewrite. A scenario is *only* a list of override names, so
    showing them is showing the whole thing.
    """
    if section == "overrides":
        from calliope_studio.modeldef.overrides import flatten

        return {"setting_count": len(flatten(value))} if isinstance(value, dict) else {}

    if section == "scenarios":
        if isinstance(value, list):
            return {"overrides": [str(item) for item in value]}
        # A single override name is accepted where a list is expected.
        return {"overrides": [str(value)]} if value else {}

    return {}


def declaring_line(block: Any, name: Any) -> int | None:
    """The 1-based line a key is written on, if ruamel recorded one.

    `templates` and `scenarios` have no structured editor, so the explorer and the
    provenance markers open them as raw YAML — and a file of forty templates opened
    at line 1 has not answered "where is this set". ruamel's round-trip loader
    carries the position of every key, so the answer is already in the document.

    Returns None rather than raising for a block that came from somewhere other
    than a round-trip load: the line is a convenience, and a tree is worth more
    than a line.
    """
    line_column = getattr(block, "lc", None)
    data = getattr(line_column, "data", None) or {}
    position = data.get(name)
    return position[0] + 1 if position else None


def scenario_catalog(base: Path) -> dict:
    """Every name `scenario=` will accept, with what each one is.

    Both sections, kept apart: Calliope takes either a scenario name or a
    comma-joined list of override names in the same argument, but they are
    different things to choose between and the Run sidebar says which is which.

    `scenario_names` below is derived from this, so the list the picker offers
    and the list `POST /runs/` validates against are the same list by
    construction rather than by two loops happening to agree.
    """
    base = Path(base).resolve()
    found: dict[str, dict[str, dict]] = {"scenarios": {}, "overrides": {}}

    for path in reachable_files(base):
        document = load_quietly(path)
        if not isinstance(document, dict):
            continue
        relative = path.relative_to(base).as_posix()
        for section in ("scenarios", "overrides"):
            block = document.get(section)
            if not isinstance(block, dict):
                continue
            for name in block:
                # First definition wins, as in `component_tree`.
                found[section].setdefault(
                    str(name),
                    {
                        "name": str(name),
                        "file": relative,
                        **_summarise(section, block.get(name)),
                    },
                )

    # A scenario naming an override no file defines cannot be run. Calliope says
    # so when it reads the model; saying it here turns "the run failed" into
    # "this scenario is incomplete" before a subprocess is spent on it. Its own
    # bundled `national_scale` ships two of them, pointing at overrides that are
    # commented out in the file beneath them.
    defined = set(found["overrides"])
    for entry in found["scenarios"].values():
        missing = [name for name in entry.get("overrides", []) if name not in defined]
        if missing:
            entry["missing"] = missing

    return {section: list(entries.values()) for section, entries in found.items()}


def scenario_names(base: Path) -> set[str]:
    """Every name `scenario=` will accept, across the import graph.

    Collected up front so a typo can be reported immediately, rather than costing
    a subprocess start, a Calliope import and a stack trace before saying "no
    such scenario".
    """
    catalog = scenario_catalog(base)
    return {entry["name"] for entries in catalog.values() for entry in entries}


def component_tree(base: Path) -> dict:
    """Merged view of which sections and entries exist, and where.

    The first file to define a section owns it; entries accumulate across files,
    first definition winning. Every section has the same shape — `{file,
    entries}` with entries as objects — rather than the Django version's mix of
    bare strings and objects depending on section.
    """
    from calliope_studio.modeldef.entities import transmission_techs

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
        relative = path.relative_to(base).as_posix()

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
                # Outside the FLAT_SECTIONS guard below: a data table is opened by
                # name in a structured editor and needs no line, but it costs
                # nothing to report one and the shape stays the same everywhere.
                line = declaring_line(block, name)
                if line is not None:
                    entry["line"] = line
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

    # Math is deliberately *not* in `TREE_SECTIONS`: that tuple drives the loop
    # above, which asks whether a top-level key of that name is in the file, and
    # `math:` is not a section of a model definition. A math source is a name in
    # `config.init.math_paths` pointing at a file the import graph cannot see, so
    # it is collected its own way and joined on here. The group shape is the same
    # as every other one, so the explorer needs no special case for it.
    root = find_model_yaml(base)
    if root is not None:
        from calliope_studio.modeldef.mathdef import math_sources

        tree["math"] = {
            "file": root.relative_to(base).as_posix(),
            "entries": math_sources(base),
        }

    return tree
