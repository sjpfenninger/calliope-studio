import calliope

# Colorblind-safe qualitative palette; the ordering matters for distinguishability
# of adjacent entries and should not be changed without re-validation.
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


def tech_colors(model: calliope.Model) -> dict:
    """Returns a tech -> hex color mapping for all techs in the model.

    Colors defined in the model inputs take precedence; any techs without a
    valid color are assigned one deterministically from `DEFAULT_PALETTE`.
    """
    techs = model.results.techs.to_index().to_list()
    defined = {}
    if "color" in model.inputs:
        for tech, color in model.inputs.color.to_series().items():
            if isinstance(color, str) and color.startswith("#"):
                defined[tech] = color
    missing = sorted(t for t in techs if t not in defined)
    fallback = {
        tech: DEFAULT_PALETTE[i % len(DEFAULT_PALETTE)]
        for i, tech in enumerate(missing)
    }
    return {tech: defined.get(tech, fallback.get(tech)) for tech in techs}
