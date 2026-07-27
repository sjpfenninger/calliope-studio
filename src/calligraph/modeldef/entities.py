"""Resolving what a model's technologies and nodes actually are.

A definition is spread over several files and leans on `template:` inheritance,
so almost nothing can be decided from one file in isolation. Whether a
technology is a transmission link, in particular, usually comes from a template
rather than from the entry itself.

**Calliope's own code does the resolving here**, not a reimplementation of it.
`calliope.io.read_rich_yaml` assembles the import graph and
`calliope.preprocess.model_definition.TemplateSolver` applies the templates. The
hand-written versions this replaced were subtly and consequentially different:
templates resolved one level deep (so `power_lines → interest_rate_setter` in
`examples/model_nld-NUTS3-v1` silently dropped `cost_interest_rate` from all 41 of
its links), `{**template, **entry}` flattened the `{data, index, dims}` mapping of
an indexed parameter that Calliope merges leaf by leaf, sections were merged per
*name* rather than per leaf so two files each contributing parameters to one
technology lost one file's worth, and a dotted key like
`techs.ccgt.flow_cap_max: 5` — legal Calliope — was not seen at all.

Both calls are wrapped, because both raise where Calliope would refuse to load the
model — a YAML syntax error, a circular template, an `import:` that is not a list —
and this module is also what serves a model in exactly that state. The fallback is
the old lenient reading, which is a *guess*, and `tests/test_resolution_parity.py`
pins how good a guess it is.

This is still only the *text* of the definition. For what needs a whole built model
— which technologies are active, what a parameter resolves to once data tables are
applied — see `calligraph.server.resolution`.
"""

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from calligraph.modeldef.imports import find_model_yaml, reachable_files
from calligraph.modeldef.paths import yaml_files
from calligraph.modeldef.yaml_io import load_quietly, to_plain

LOGGER = logging.getLogger(__name__)

#: Calliope 0.7 has no `links:` section. Transmission is an ordinary technology
#: with these two keys, and their presence identifies one even when `base_tech`
#: is inherited from a template that has not been resolved yet.
LINK_KEYS = ("link_from", "link_to")

TRANSMISSION = "transmission"

#: How many assembled definitions to keep. Small: assembly is asked for several
#: times per request — geometry alone wants nodes, techs and colours — and the
#: point of the cache is that one request pays for it once.
_CACHE_SIZE = 4

#: `{(entry file, yaml fingerprint): Definition | None}`.
_assembled_cache: dict[tuple, "Definition | None"] = {}


@dataclass(frozen=True)
class Definition:
    """A model definition, assembled and with templates applied."""

    #: Top-level sections — `techs`, `nodes`, `config`, … — with every `template:`
    #: already merged in and the key itself consumed, as Calliope leaves them.
    sections: dict = field(default_factory=dict)
    #: The templates themselves, each fully resolved against the ones it inherits
    #: from. `TemplateSolver` strips the section out of the data, and this is where
    #: it goes.
    templates: dict = field(default_factory=dict)


def assembled(base: Path) -> Definition | None:
    """The whole definition, through Calliope's own assembly and template solver.

    `allow_override=True` because Calliope raises on a leaf defined in two files of
    the import graph, and the editor has to show that model anyway — it is the
    user's, and saying so is `validate`'s job, not the map's.

    Returns:
        The definition, or None if it could not be read at all.
    """
    root = Path(base).resolve()
    model_yaml = find_model_yaml(root)
    if model_yaml is None:
        return None

    key = (str(model_yaml), _yaml_fingerprint(root))
    if key in _assembled_cache:
        return _assembled_cache[key]

    definition = None
    try:
        from calliope.io import read_rich_yaml
        from calliope.preprocess.model_definition import TemplateSolver

        document = read_rich_yaml(model_yaml, allow_override=True)
        # `overrides:` and `scenarios:` are not part of the base definition, and
        # Calliope removes them — in `_load_scenario_overrides` — *before* the
        # template solver runs. Left in, they break it: `national_scale`'s
        # `cold_fusion` override names a template that only exists under another
        # override, and the solver raises `KeyError: 'cost_dim_setter'` walking it.
        for key_to_drop in ("overrides", "scenarios"):
            document.pop(key_to_drop, None)

        solver = TemplateSolver(document)
        definition = Definition(
            sections=_plain(solver.resolved_data),
            templates=_plain(solver.resolved_templates),
        )
    except Exception as caught:
        # Logged, not silent. The fallback below is slower and less complete, and a
        # model that stopped assembling for a reason nobody can see is how this
        # class of bug goes unnoticed in the first place.
        LOGGER.debug("could not assemble %s: %s", model_yaml, caught)

    _assembled_cache[key] = definition
    while len(_assembled_cache) > _CACHE_SIZE:
        _assembled_cache.pop(next(iter(_assembled_cache)))
    return definition


def _yaml_fingerprint(root: Path) -> tuple:
    """Enough to notice any YAML in the workspace changing.

    A superset of what the import graph reaches, deliberately: finding the exact
    set means parsing the files, which is the work being cached. A glob and a stat
    each is cheap, and over-invalidating costs one re-assembly.
    """
    entries = []
    for path in yaml_files(root):
        try:
            stat = path.stat()
        except OSError:
            continue
        entries.append((str(path), stat.st_mtime_ns, stat.st_size))
    return tuple(sorted(entries))


def _plain(mapping: Any) -> dict:
    """One level of a Calliope `AttrDict` as plain, JSON-safe entries."""
    if not isinstance(mapping, dict):
        return {}
    return {str(name): to_plain(value) for name, value in mapping.items()}


def merged_section(base: Path, section: str) -> dict:
    """One top-level section, assembled across the import graph and resolved.

    "Resolved" meaning templates applied. Callers that want a section exactly as
    one file spells it — the editors, which write it back — go through
    `server.routes.yaml_sections` instead; this is the semantic view.
    """
    definition = assembled(base)
    if definition is None:
        return _resolve_shallowly(
            _merged_leniently(base, section), _merged_leniently(base, "templates")
        )
    if section == "templates":
        return definition.templates
    block = definition.sections.get(section)
    return block if isinstance(block, dict) else {}


def _merged_leniently(base: Path, section: str) -> dict:
    """The fallback: first definition of a name wins, per file, no assembly.

    Wrong in the ways the module docstring lists, and right in the one way that
    matters when it is reached: it cannot fail on a model that does not parse as a
    whole, because it never looks at the whole.
    """
    base = Path(base).resolve()
    merged: dict = {}
    for path in reachable_files(base):
        document = load_quietly(path)
        if not isinstance(document, dict):
            continue
        block = document.get(section)
        if not isinstance(block, dict):
            continue
        for name, definition in block.items():
            merged.setdefault(str(name), to_plain(definition) or {})
    return merged


def resolve_templates(entries: dict, templates: dict) -> dict:
    """Applies `template:` inheritance to a section, through Calliope's solver.

    Recursive, cycle-detecting and leaf-level, because it *is* Calliope's
    `TemplateSolver`. For callers that hold a section already — the frozen sections
    of a snapshot, say — rather than a workspace to assemble.
    """
    try:
        from calliope.attrdict import AttrDict
        from calliope.preprocess.model_definition import TemplateSolver

        solver = TemplateSolver(
            AttrDict({"templates": dict(templates), "section": dict(entries)})
        )
        return _plain(solver.resolved_data.get("section") or {})
    except Exception:
        return _resolve_shallowly(entries, templates)


def _resolve_shallowly(entries: dict, templates: dict) -> dict:
    """One level, last resort. See `resolve_templates`."""
    resolved = {}
    for name, entry in entries.items():
        if not isinstance(entry, dict):
            resolved[str(name)] = {}
            continue
        template = (
            templates.get(entry.get("template"), {}) if entry.get("template") else {}
        )
        resolved[str(name)] = {**template, **entry}
    return resolved


def harmonise_coordinates(nodes: Any) -> Any:
    """Makes each node's coordinate pair the same numeric type before it is written.

    Calliope rejects a mixed pair outright — *"Invalid latitude/longitude
    definition. Types must match, found (41.5, -2)"* — and a mixed pair is
    startlingly easy to produce. Dragging a node on the map sends two rounded
    numbers over JSON, where JavaScript cannot express "the float 40": `40.0`
    serialises as `40`, so a node dragged to exactly `-2` longitude arrives as an
    int beside a float latitude and the model stops loading.

    Only a pair that is actually mixed is touched, so a hand-written
    `latitude: 40 / longitude: -2` keeps the spelling its author chose.
    """
    if not isinstance(nodes, dict):
        return nodes
    for definition in nodes.values():
        if not isinstance(definition, dict):
            continue
        pair = [definition.get(key) for key in ("latitude", "longitude")]
        if any(value is None or isinstance(value, bool) for value in pair):
            continue
        if not all(isinstance(value, (int, float)) for value in pair):
            continue
        if any(isinstance(value, float) for value in pair) and any(
            isinstance(value, int) for value in pair
        ):
            definition["latitude"] = float(pair[0])
            definition["longitude"] = float(pair[1])
    return nodes


def resolved_techs(base: Path) -> dict[str, dict]:
    """Every technology, with its template applied."""
    return merged_section(base, "techs")


def is_transmission(entry: Any) -> bool:
    """Whether a resolved technology is a transmission link.

    Calliope's own test is `base_tech == "transmission"` and nothing else. The
    endpoint clause below is a *guess*, for a definition whose `base_tech` could not
    be resolved, and it is a guess in both directions: an ordinary technology
    carrying `link_from` is not a link to Calliope. Where a resolved model is
    available, prefer its answer — see `server.resolution`.
    """
    if not isinstance(entry, dict):
        return False
    if entry.get("base_tech") == TRANSMISSION:
        return True
    return all(entry.get(key) for key in LINK_KEYS)


def transmission_techs(base: Path) -> set[str]:
    """Names of every technology that connects two nodes."""
    return {
        name for name, entry in resolved_techs(base).items() if is_transmission(entry)
    }
