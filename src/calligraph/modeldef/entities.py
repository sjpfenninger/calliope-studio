"""Resolving what a model's technologies and nodes actually are.

A definition is spread over several files and leans on `template:` inheritance,
so almost nothing can be decided from one file in isolation. Whether a
technology is a transmission link, in particular, usually comes from a template
rather than from the entry itself.

Shared by the geometry reader and the component tree, which both need the same
resolved view.
"""

from pathlib import Path
from typing import Any

from calligraph.modeldef.imports import reachable_files
from calligraph.modeldef.yaml_io import load_quietly, to_plain

#: Calliope 0.7 has no `links:` section. Transmission is an ordinary technology
#: with these two keys, and their presence identifies one even when `base_tech`
#: is inherited from a template that has not been resolved yet.
LINK_KEYS = ("link_from", "link_to")

TRANSMISSION = "transmission"


def merged_section(base: Path, section: str) -> dict:
    """Collects one top-level section across the whole import graph.

    The first definition of a name wins, which is how Calliope resolves them.
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
    """Applies `template:` inheritance, one level deep.

    Calliope supports templates inheriting from templates; one level covers the
    example models and everything the editor needs, and going deeper would mean
    reimplementing Calliope's own resolution here.
    """
    resolved = {}
    for name, entry in entries.items():
        if not isinstance(entry, dict):
            resolved[name] = {}
            continue
        template = (
            templates.get(entry.get("template"), {}) if entry.get("template") else {}
        )
        resolved[name] = {**template, **entry}
    return resolved


def resolved_techs(base: Path) -> dict[str, dict]:
    """Every technology, with its template applied."""
    return resolve_templates(
        merged_section(base, "techs"), merged_section(base, "templates")
    )


def is_transmission(entry: Any) -> bool:
    """Whether a resolved technology is a transmission link."""
    if not isinstance(entry, dict):
        return False
    if entry.get("base_tech") == TRANSMISSION:
        return True
    # A link that inherits `base_tech` from a template it does not name is still
    # unmistakable from its endpoints.
    return all(entry.get(key) for key in LINK_KEYS)


def transmission_techs(base: Path) -> set[str]:
    """Names of every technology that connects two nodes."""
    return {
        name for name, entry in resolved_techs(base).items() if is_transmission(entry)
    }
