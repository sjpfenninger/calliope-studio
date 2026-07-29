"""The rendered math, checked against Calliope's own document.

`runs.mathdoc` does not call `generate_math_doc`, because that emits one whole
document and the Math tab browses components. It reads the LaTeX back out of the
dataset attrs Calliope stashed it in and applies Calliope's two KaTeX escaping
filters through `backend._render`.

**This file is the price of that.** Every LaTeX string the payload carries must
appear verbatim inside `MathDocumentation.write(format="md")` for the same model.
If Calliope renames an attr, reorders a filter or changes what `_render`
registers, this fails with the two strings in front of you — rather than the app
silently drawing notation that is subtly not the model's, which is a defect no
amount of looking at the screen would find, because wrong math looks exactly like
right math.

The provenance assertions are the other half. `model.math.init` keeps every named
math block, so "which source defines this component, and did a later one replace
it" is answerable — and `urban_scale` is the case that matters, because its
`additional_math.yaml` both *adds* a constraint and *overrides* a base one, and
the override is invisible in the YAML.
"""

import pytest

from calliope_studio.runs import mathdoc


@pytest.fixture(scope="module")
def rendered(request):
    """The payload and Calliope's own markdown for one model, rendered once.

    Module-scoped: `MathDocumentation` parses every expression and every `where`
    in the formulation, which is ~8 seconds. Rendering it per test would make
    this file the slowest in the suite by an order of magnitude.
    """
    import calliope
    from calliope.postprocess import MathDocumentation

    model = calliope.examples.urban_scale()
    return {
        "payload": mathdoc.render(model),
        "document": MathDocumentation(model, include="all").write(format="md"),
    }


@pytest.fixture
def components(rendered):
    """Every component of the payload, by name."""
    return {
        component["name"]: component
        for group in rendered["payload"]["groups"]
        for component in group["components"]
    }


class TestParity:
    def test_every_equation_matches_calliopes_own(self, rendered, components):
        """The guard on reading `math_string` and calling `backend._render`.

        Verbatim containment, not similarity: the escaping is the whole point.
        Underscores inside `\\text{}` have to be backslash-escaped and nested
        `\\text{}` has to be wrapped in `\\(…\\)`, or KaTeX renders nothing —
        which is exactly the kind of difference an "approximately equal" check
        would let through.
        """
        document = rendered["document"]
        missing = [
            name
            for name, component in components.items()
            if component.get("latex") and component["latex"] not in document
        ]

        assert not missing, f"not found verbatim in Calliope's own document: {missing}"

    def test_there_is_something_to_compare(self, components):
        """A parity test that compares nothing passes, and means nothing."""
        with_latex = [c for c in components.values() if c.get("latex")]

        assert len(with_latex) > 40

    def test_the_groups_calliope_documents_are_all_present(self, rendered):
        keys = [group["key"] for group in rendered["payload"]["groups"]]

        assert keys[:2] == ["objectives", "constraints"]
        assert {"variables", "global_expressions", "parameters"} <= set(keys)


class TestProvenance:
    def test_a_user_constraint_names_its_source(self, components):
        """`link_chp_outputs` exists only in `additional_math.yaml`."""
        component = components["link_chp_outputs"]

        assert component["sources"] == ["additional_math"]
        assert component["origin"] == "additional_math"
        assert component["overridden"] is False

    def test_an_overridden_constraint_lists_both_sources_in_order(self, components):
        """The thing that is invisible in the YAML, and the reason for `sources`.

        `additional_math.yaml` redefines `balance_conversion`, which `base.yaml`
        already defines. Nothing in either file says so, and the rendered
        equation is the *second* one — so without this the tab would show a base
        constraint's name above a user's math with no explanation.
        """
        component = components["balance_conversion"]

        assert component["sources"] == ["base", "additional_math"]
        assert component["origin"] == "additional_math"
        assert component["overridden"] is True

    def test_base_math_is_attributed_to_base(self, components):
        assert components["flow_cap"]["origin"] == "base"
        assert components["flow_cap"]["overridden"] is False

    def test_the_applied_priority_says_which_entries_are_the_users(self, rendered):
        assert rendered["payload"]["priority"] == [
            {"name": "base", "kind": "builtin"},
            {"name": "additional_math", "kind": "user"},
        ]


class TestPayload:
    def test_a_component_carries_what_the_detail_pane_shows(self, components):
        component = components["link_chp_outputs"]

        assert component["group"] == "constraints"
        assert component["description"]
        assert component["latex"].startswith("\\begin{array}")
        assert "heat_to_power_ratio" in component["uses"]
        # The YAML is shown beside the notation because the LaTeX is its
        # consequence, and someone writing math needs to see the cause.
        assert "equations:" in component["yaml"]

    def test_references_run_both_ways(self, components):
        """`uses` is the inversion of the `references` the dataset records."""
        parameter = components["heat_to_power_ratio"]

        assert parameter["used_in"] == ["link_chp_outputs"]
        assert parameter["uses"] == []

    def test_a_parameter_nothing_refers_to_is_left_out(self, components):
        """Otherwise Parameters is a dump of every default Calliope declares.

        The same rule `generate_math_doc` applies. `urban_scale` uses a fraction
        of the base parameter set, so the difference is most of the list.
        """
        assert "spores_score" not in components

    def test_the_active_objective_is_named(self, rendered):
        assert rendered["payload"]["objective"] == "min_cost_optimisation"


class TestKatexCompatibility:
    """The escaping is not cosmetic: unescaped, KaTeX renders none of this."""

    def test_underscores_inside_text_blocks_are_escaped(self, components):
        latex = components["balance_conversion"]["latex"]

        assert r"\textit{base\_tech}" in latex
        # …and only inside them. A subscript is ordinary math, and escaping there
        # would print a literal backslash.
        assert r"_\text{node,tech,carrier,timestep}" in latex

    def test_the_payload_is_json_the_browser_can_parse(self, rendered):
        """`.inf` and `nan` are not JSON, and eighteen base parameters use them.

        `json.dumps` writes them as the bare tokens `Infinity` and `NaN`, which
        `JSON.parse` rejects — so this is not one field rendering oddly, it is
        the whole payload failing to load. `allow_nan=False` is what makes this
        an assertion rather than a hope.
        """
        import json

        payload = rendered["payload"]

        assert json.loads(json.dumps(payload, allow_nan=False)) == payload

    def test_an_unbounded_default_crosses_the_wire_as_a_string(self, components):
        """`.inf`, as it is spelled everywhere else in this application."""
        assert components["flow_cap_max"]["default"] == ".inf"

    def test_an_absent_default_is_not_reported_as_a_value(self, components):
        """Calliope's `nan` default means the math declares none."""
        assert "default" not in components["area_use_per_flow_cap"]
