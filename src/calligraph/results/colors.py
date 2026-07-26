"""Deterministic technology colours.

A technology must be the same colour everywhere it appears — in the editor, on
the map, and in every chart — and the same colour on every machine. Colours
defined in the model win; the rest are assigned from a fixed palette in sorted
order, so the assignment does not depend on dictionary or file ordering.
"""

#: Colourblind-safe qualitative palette. The ordering is load-bearing: adjacent
#: entries were chosen to be distinguishable, so do not reorder without
#: re-validating.
DEFAULT_PALETTE = (
    "#2a78d6",
    "#eb6834",
    "#1baf7a",
    "#eda100",
    "#e87ba4",
    "#008300",
    "#4a3aa7",
    "#e34948",
)


def tech_colors(model) -> dict[str, str]:
    """Maps every technology in a model to a hex colour."""
    techs = model.results.techs.to_index().to_list()

    defined = {}
    if "color" in model.inputs:
        for tech, color in model.inputs.color.to_series().items():
            if isinstance(color, str) and color.startswith("#"):
                defined[tech] = color

    missing = sorted(tech for tech in techs if tech not in defined)
    fallback = {
        tech: DEFAULT_PALETTE[index % len(DEFAULT_PALETTE)]
        for index, tech in enumerate(missing)
    }
    return {tech: defined.get(tech, fallback.get(tech)) for tech in techs}
