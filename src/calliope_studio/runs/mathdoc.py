"""The model's math, rendered to LaTeX one component at a time.

Calliope owns this entirely. `MathDocumentation` builds a `LatexBackendModel` —
a real backend that emits notation instead of a solver problem — and every LaTeX
string here is one it produced. Nothing in this module parses an expression, a
`where` string or a `foreach` list, and nothing in it should ever start to; that
is the mistake the package docstring is about, and math is the worst possible
place to make it.

**Why this does not call `generate_math_doc`.** That is the public way out, and it
returns a whole document — one string of every component in one order with the
group headings baked in. The Math tab browses: it filters by source, jumps to a
component by name, and follows a `Uses` reference to another one. So the
components are read back individually, from the dataset attrs Calliope stashed
them in, and only the two KaTeX escaping filters are borrowed —
`backend._render` with a one-line template, rather than a second copy of two
regexes whose comments in Calliope say "KaTeX requires…".

`tests/test_math_render.py` is what makes that safe: every LaTeX string this
module emits must appear **verbatim** inside `MathDocumentation.write(format="md")`
for the same model. If Calliope moves an attr or changes a filter, the test fails
with the two strings side by side instead of the app quietly drawing wrong
notation — which is a failure nobody would catch by eye, since wrong math looks
exactly like right math.

**Why this needs no `model.build()`.** `MathDocumentation` reads `model.inputs`,
`model.math.build` and `model.config.build`, and `math.build` is populated during
*init* (`calliope/model.py`, `model_def.update({"math.build": …})`). So a model
from `read_yaml` — or one read back out of a `.nc` — already carries everything.
Measured: 4.4 s for national_scale, 8.0 s for urban_scale, all of it parsing.
"""

import json
import math
from pathlib import Path
from typing import Any

#: Groups to report, in the order Calliope's own documentation presents them.
#: Objectives first because that is what the model is *for*; parameters and
#: lookups last because they are inputs rather than formulation.
GROUPS = (
    "objectives",
    "constraints",
    "piecewise_constraints",
    "global_expressions",
    "variables",
    "parameters",
    "lookups",
)

#: What each group is called in Calliope's own math documentation. Not a title
#: case of the key: "Subject to" and "Where" are the conventional names for a
#: constraint set and an expression block in a written formulation, and a user
#: reading a paper about their own model will meet these.
GROUP_LABELS = {
    "objectives": "Objective",
    "constraints": "Subject to",
    "piecewise_constraints": "Subject to (piecewise)",
    "global_expressions": "Where",
    "variables": "Decision variables",
    "parameters": "Parameters",
    "lookups": "Lookups",
}

#: Calliope's own escaping, applied through Calliope's own jinja environment.
#: `escape_underscores` and `mathify_text_in_text` are what make the difference
#: between a string KaTeX renders and one it refuses.
_ESCAPE = "{{ x | trim | escape_underscores | mathify_text_in_text }}"


def render(model: Any) -> dict:
    """Every math component of a model, with its LaTeX and where it came from.

    Args:
        model: An initialised `calliope.Model`. Need not be built or solved.

    Returns:
        `{mode, priority, groups: [{key, label, components: [...]}]}`.
    """
    from calliope.postprocess import MathDocumentation

    # "all" rather than "valid": a component whose `where` matches nothing in
    # *this* model is still part of the formulation, and hiding it would make a
    # constraint the user just wrote vanish with no explanation — which reads as
    # the file not having been picked up.
    documentation = MathDocumentation(model, include="all")
    backend = documentation.backend
    origins = _origins(model)
    priority = _priority(model)

    groups = []
    for group in GROUPS:
        dataset = getattr(backend, group, None)
        if dataset is None or not dataset.data_vars:
            continue
        components = [
            component
            for name, array in sorted(dataset.data_vars.items())
            if (component := _component(backend, group, str(name), array, origins))
        ]
        if components:
            groups.append(
                {"key": group, "label": GROUP_LABELS[group], "components": components}
            )

    return {
        "mode": str(model.config.init.mode),
        "priority": priority,
        "objective": str(getattr(backend, "objective", "") or ""),
        "groups": groups,
    }


def write(model: Any, destination: Path) -> None:
    """Renders and writes the payload the Math tab reads.

    `allow_nan=False` deliberately: Python's default is to write the bare tokens
    `Infinity` and `NaN`, which are not JSON and which `JSON.parse` refuses — so
    a single unbounded parameter would produce a file the browser cannot read at
    all. `_plain` converts the ones we know about; this makes any we do not fail
    here, loudly, instead of silently downstream.
    """
    payload = json.dumps(render(model), indent=2, default=str, allow_nan=False)
    Path(destination).write_text(payload)


def _component(
    backend: Any, group: str, name: str, array: Any, origins: dict[str, list[str]]
) -> dict | None:
    """One component, or None if it has nothing to show.

    Parameters and lookups carry no equation of their own — they are symbols —
    so they are worth listing only when some equation refers to them. That is the
    same rule `generate_math_doc` applies, and it is what keeps the Parameters
    group from being a dump of every default Calliope declares.
    """
    attrs = array.attrs
    latex = attrs.get("math_string")
    references = attrs.get("references") or set()
    if not latex and not (group in ("parameters", "lookups") and references):
        return None

    key = f"{group}:{name}"
    sources = origins.get(key, [])
    component: dict[str, Any] = {
        "name": name,
        "group": group,
        "title": str(attrs.get("title") or ""),
        "description": str(attrs.get("description") or ""),
        "unit": str(attrs.get("unit") or ""),
        "uses": sorted(_uses(backend, name)),
        "used_in": sorted(str(item) for item in references if str(item) != name),
        "sources": sources,
        # The last source to define a name is the one in effect; more than one
        # means a later file redefined an earlier one, which is the single most
        # important thing a custom-math author needs to see and the thing that is
        # invisible in the YAML.
        "origin": sources[-1] if sources else None,
        "overridden": len(sources) > 1,
    }

    if latex:
        component["latex"] = backend._render(_ESCAPE, x=latex)
    default = _plain(attrs.get("default"))
    if default is not None:
        component["default"] = default
    if attrs.get("dtype") is not None:
        component["dtype"] = str(attrs["dtype"])
    yaml_snippet = _yaml(backend, group, name)
    if yaml_snippet:
        component["yaml"] = yaml_snippet
    return component


def _plain(value: Any) -> Any:
    """A default value JSON can actually carry.

    Eighteen of `base.yaml`'s parameters default to `.inf` and several to `nan`,
    and `json.dumps` writes those as the bare tokens `Infinity` and `NaN` —
    which are not JSON, and which `JSON.parse` rejects outright. Not "renders
    oddly": the *entire payload* fails to parse, so one unbounded parameter takes
    the whole Math tab down.

    `.inf` becomes the string `".inf"`, which is how infinity crosses the wire
    everywhere else in this application (`modeldef.yaml_io.to_plain`) and how
    Calliope spells it in YAML. Spelled out again here rather than imported,
    because `runs` may not import `modeldef`.

    `nan` becomes None: in Calliope's schema it is the *absence* of a default,
    so reporting it as a value would be reporting something the math does not say.
    """
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, float) or hasattr(value, "item"):
        try:
            value = value.item() if hasattr(value, "item") else value
        except (AttributeError, ValueError):
            return str(value)
    if isinstance(value, float):
        if math.isnan(value):
            return None
        if math.isinf(value):
            return ".inf" if value > 0 else "-.inf"
    return value if isinstance(value, (int, float, str)) else str(value)


def _uses(backend: Any, name: str) -> set[str]:
    """What this component refers to.

    The dataset records the relation the other way round — each array lists what
    references *it* — so this is the inversion `generate_math_doc` also does.
    """
    return {
        str(other)
        for other, array in backend._dataset.data_vars.items()
        if str(other) != name and name in (array.attrs.get("references") or set())
    }


def _yaml(backend: Any, group: str, name: str) -> str:
    """The component exactly as it is defined, defaults omitted.

    Shown beside the notation because the LaTeX is the *consequence* of the YAML
    and a user writing math needs to see the cause. `exclude_defaults` so a
    two-line constraint does not print forty keys it never set.
    """
    from calliope.io import to_yaml

    try:
        return to_yaml(backend.math[group][name].model_dump(exclude_defaults=True))
    except (AttributeError, KeyError, TypeError):
        # A component the backend synthesised rather than read — variable bounds
        # become constraints, for one. There is no YAML to show, and that is not
        # an error.
        return ""


def _origins(model: Any) -> dict[str, list[str]]:
    """Which math source defines each component, in the order they are applied.

    `model.math.init` keeps every named block as it was loaded — the built-in
    ones and the user's alike — and survives a round trip through netCDF, so this
    works on a solved model as well as a fresh one. Walking it in priority order
    gives both halves of the answer: the last name is what is in effect, and the
    length is whether anything was overridden.
    """
    from calliope.preprocess import model_math

    priority = model_math.get_math_priority(model.config.init)
    definitions = model.math.init.model_dump()

    origins: dict[str, list[str]] = {}
    for source in priority:
        block = definitions.get(source) or {}
        for group in GROUPS:
            for name in block.get(group) or {}:
                origins.setdefault(f"{group}:{name}", []).append(source)
    return origins


def _priority(model: Any) -> list[dict]:
    """The applied math, in order, saying which entries are the user's own."""
    from calliope.preprocess import model_math

    declared = set(model.config.init.math_paths.root or {})
    return [
        {"name": name, "kind": "user" if name in declared else "builtin"}
        for name in model_math.get_math_priority(model.config.init)
    ]
