"""Which technologies are transmission links, and what they join.

Calliope 0.7 has no `links:` section — a link is a technology carrying `link_from`
and `link_to`. Where those two survive to depends on how the model was written, and
absorbing that difference is the whole job of this module.

`modeldef.geo.link_orientation` answers the same question for the *editor*, from the
declaration on disk. It cannot serve the results view: it takes a workspace path, and
a `.nc` opened straight from the command line has no workspace at all. So this reads
the loaded model instead, in order of how directly it states the answer:

  - `inputs.link_from` / `inputs.link_to`, which exist only when the endpoints
    arrived as ordinary parameters from a data table — as they do for
    `examples/model_nld-NUTS3-v1`;
  - `model.definition`, Calliope's own record of what the definition said, which
    keeps them either way. `_links_to_node_format` consumes the inline YAML form
    during preprocessing, so for `national_scale` and `urban_scale` this is the only
    place the endpoints still exist.

There is deliberately no third guess. A link whose endpoints cannot be established
is still a link — it keeps its raw name and its place in the filter — because
`links_geojson` already falls back to coordinate order for the geometry, and the
sidebar showing a technology under the name the model gave it is never wrong. Deriving
"from" and "to" from the order two nodes happen to sit in the `nodes` coordinate is:
measured against the declaration, it reverses 6 of `model_nld-NUTS3-v1`'s 41 links.
"""

from dataclasses import dataclass
from typing import Iterable

import pandas as pd

from calliope_studio.results.catalog import base_tech_members

#: Joins the two ends in a link's display name. An arrow rather than a dash because
#: the pair is ordered, and `link_from` is where a one-way link flows from.
ARROW = " → "


@dataclass(frozen=True)
class Link:
    """A transmission technology and the two nodes it connects.

    Attributes:
        tech: The technology's name in the model.
        node_from: Its `link_from`, or None where the model does not say.
        node_to: Its `link_to`, or None where the model does not say.
    """

    tech: str
    node_from: str | None = None
    node_to: str | None = None

    @property
    def label(self) -> str:
        """`from → to`, falling back to the raw name when the ends are unknown."""
        if self.node_from and self.node_to:
            return f"{self.node_from}{ARROW}{self.node_to}"
        return self.tech

    def as_dict(self) -> dict:
        return {"tech": self.tech, "from": self.node_from, "to": self.node_to}


def _named(value) -> str | None:
    """A usable node name, or None.

    Non-link technologies carry `link_from` as an empty string rather than as a
    missing value once it has been through a data table, so blank has to count as
    absent alongside NaN.
    """
    if value is None or pd.isna(value):
        return None
    name = str(value).strip()
    return name or None


def _from_inputs(model) -> dict[str, tuple[str, str]]:
    """Endpoints carried as ordinary parameters on the `techs` dimension."""
    inputs = getattr(model, "inputs", None)
    if inputs is None or "link_from" not in inputs or "link_to" not in inputs:
        return {}

    sources = inputs.link_from.to_series()
    targets = inputs.link_to.to_series()
    found = {}
    for tech in sources.index:
        source, target = _named(sources.get(tech)), _named(targets.get(tech))
        if source and target:
            found[str(tech)] = (source, target)
    return found


def _from_definition(model) -> dict[str, tuple[str, str]]:
    """Endpoints as Calliope recorded the definition.

    Degrades to nothing rather than raising: this reaches into Calliope's own schema
    classes, and a shape change there should cost the labels, not the catalogue.
    """
    try:
        techs = model.definition.techs.root
    except AttributeError:
        return {}

    found = {}
    for name, entry in techs.items():
        # Absent, not None, on a technology that never declared them.
        source = _named(getattr(entry, "link_from", None))
        target = _named(getattr(entry, "link_to", None))
        if source and target:
            found[str(name)] = (source, target)
    return found


def link_orientation(model) -> dict[str, tuple[str, str]]:
    """`{tech: (from, to)}` for every link the model states the ends of.

    The results-view counterpart to `modeldef.geo.link_orientation`, and what
    `results.geo.links_geojson` wants for its `orientation` argument.
    """
    oriented = _from_definition(model)
    # Inputs win: a data table is the model as it was actually built, and where both
    # sources have an opinion it is the later one.
    oriented.update(_from_inputs(model))
    return oriented


def transmission_links(model, order: Iterable[str] | None = None) -> list[Link]:
    """Every transmission technology, with its endpoints where they are known.

    Membership comes from `base_tech`, which Calliope resolves for us, so a link is
    listed whether or not its ends could be established.

    Args:
        model: A loaded Calliope model.
        order: The order to return them in — the `techs` coordinate as the catalogue
            reports it, so the sidebar, the merged selector and the catalogue all
            agree. `base_tech_members` sorts alphabetically, which is *not* that
            order, hence passing it in rather than inferring it.
    """
    members = base_tech_members(model, "transmission")
    if not members:
        return []

    oriented = link_orientation(model)
    ranked = list(order) if order is not None else []
    position = {name: index for index, name in enumerate(ranked)}
    # Anything the caller did not rank goes last, in the order `base_tech` gave it.
    members.sort(key=lambda tech: (position.get(tech, len(position)), tech))

    return [Link(tech, *oriented.get(tech, (None, None))) for tech in members]
