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

import pathlib

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

    def test_no_notation_is_an_empty_array(self, components):
        """The string that used to reach the browser for a `where` matching nothing.

        Calliope stores a bare NaN array for such a component and, asked for
        `include="all"`, renders its template over that — which is a valid
        LaTeX array of zero rows, so KaTeX draws nothing, reports nothing, and
        the tab shows a blank where the equation goes. `_component` has to mark
        the component `unmatched` and carry no `latex` instead.
        """
        empty = "\\begin{array}{l}\n\\end{array}"
        blank = [
            name
            for name, component in components.items()
            if component.get("latex", "").strip() == empty
        ]

        assert not blank

    def test_there_is_something_to_compare(self, components):
        """A parity test that compares nothing passes, and means nothing.

        urban_scale renders 38: the components whose `where` matches nothing
        there are listed `unmatched` and carry no `latex`, so they are not
        compared — there is nothing of Calliope's to compare them to.
        """
        with_latex = [c for c in components.values() if c.get("latex")]

        assert len(with_latex) > 30

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


@pytest.fixture(scope="module")
def dispatch(tmp_path_factory):
    """A model shaped like a dispatch model, which is the awkward case.

    Capacities are given rather than chosen, so `flow_cap` is declared as a
    *parameter* and the base-math *variable* of the same name is switched off —
    what Calliope's own `operate.yaml` does, and what a real assignment model
    doing economic dispatch in `base` mode does by hand.

    Built here rather than taken from `examples/`, which is gitignored: this has
    to run on a fresh clone.
    """
    import calliope

    root = pathlib.Path(calliope.__file__).parent / "example_models" / "national_scale"
    math_file = tmp_path_factory.mktemp("math") / "dispatch.yaml"
    math_file.write_text(
        "parameters:\n"
        "  flow_cap:\n"
        "    default: .inf\n"
        "    title: Rated flow capacity.\n"
        "    unit: power\n"
        "variables:\n"
        "  flow_cap.active: false\n"
    )
    model = calliope.read_yaml(
        str(root / "model.yaml"),
        override_dict={
            "config.init.math_paths.dispatch": str(math_file),
            "config.init.extra_math": ["dispatch"],
            # So `flow_cap` is real input data and reaches the backend as a
            # parameter, which is what the variable then collides with.
            "techs.ccgt.flow_cap": 40000,
        },
    )
    return {
        f"{component['group']}:{component['name']}": component
        for group in mathdoc.render(model)["groups"]
        for component in group["components"]
    }


class TestDeactivatedComponents:
    """`active: false`, which Calliope's LaTeX backend cannot render itself.

    `BackendModel._add_component` lets an inactive component whose name is
    already in the backend dataset short-circuit before the pre-existence check
    — which is what makes a dispatch model buildable under Pyomo. But
    `LatexBackendModel` passes `break_early=False` on every `add_*`, so that
    branch never runs and the check raises instead: *"Trying to add already
    existing *parameter* `flow_cap` as a backend model *variable*."* Rendering
    the math of any dispatch or operate-mode model was impossible, upstream's
    own `generate_math_doc` included.

    The same line has a second consequence on models that do render: a
    deactivated component was parsed and drawn as though it were live math, so a
    file switching thirteen constraints off produced a tab listing all thirteen
    as part of the formulation. Wrong math looks exactly like right math.
    """

    def test_a_parameter_may_shadow_a_deactivated_variable(self, dispatch):
        """The crash. Without `_build_math` this fixture raises `BackendError`."""
        assert "variables:flow_cap" in dispatch
        assert "parameters:flow_cap" in dispatch

    def test_a_deactivated_component_carries_no_notation(self, dispatch):
        """An equation is the one thing that would say it is in the model."""
        component = dispatch["variables:flow_cap"]

        assert component["deactivated"] is True
        assert "latex" not in component
        # Listed rather than dropped, and with enough to be worth reading: an
        # author needs to see that their `active: false` was picked up, and
        # vanishing reads as the file not having been read at all.
        assert "active: false" in component["yaml"]
        assert component["title"]

    def test_it_names_the_file_that_switched_it_off(self, dispatch):
        """Which is the question a reader actually has, and `origin` answers it."""
        component = dispatch["variables:flow_cap"]

        assert component["sources"] == ["base", "dispatch"]
        assert component["origin"] == "dispatch"

    def test_the_parameter_of_the_same_name_still_renders(self, dispatch):
        """The half of the pair that *is* in the formulation is untouched."""
        component = dispatch["parameters:flow_cap"]

        assert not component.get("deactivated")
        assert component["used_in"]

    def test_nothing_else_is_taken_out(self, dispatch):
        """Only what the math deactivates, not everything sharing a name.

        national_scale deactivates one component, so exactly one comes back
        marked — a filter that removed the parameter too, or the whole `base`
        variables block, would still satisfy every assertion above.
        """
        marked = [key for key, value in dispatch.items() if value.get("deactivated")]

        assert marked == ["variables:flow_cap"]


class TestUnmatchedComponents:
    """A `where` that matches nothing here: the other reason for no notation.

    `balance_conversion` is in every model's math and national_scale has no
    conversion technology, so it binds to nothing there. It is still part of
    the formulation as declared — `include="all"` is asked for precisely so a
    constraint the user just wrote does not vanish — but the notation Calliope
    produces for it is an empty array block, and shipping that drew a blank
    the user could not tell from a rendering failure.
    """

    def test_a_constraint_nothing_binds_to_is_listed_without_notation(self, dispatch):
        component = dispatch["constraints:balance_conversion"]

        assert component["unmatched"] is True
        assert "latex" not in component
        assert not component.get("deactivated")
        # What the reader wants next is the condition that matched nothing,
        # and the YAML is where it is.
        assert "where:" in component["yaml"]
        assert "base_tech" in component["uses"]

    def test_a_constraint_that_binds_is_untouched(self, dispatch):
        component = dispatch["constraints:system_balance"]

        assert component["latex"].startswith("\\begin{array}")
        assert "unmatched" not in component

    def test_a_symbol_is_never_marked(self, dispatch):
        """A parameter has no `where`; an all-NaN one is "no data", not "no match".

        That case is already answered by the `references` rule, and a second
        answer would mark every default Calliope declares and nobody set.
        """
        symbols = [
            component
            for key, component in dispatch.items()
            if key.startswith(("parameters:", "lookups:"))
        ]

        assert symbols
        assert not any(component.get("unmatched") for component in symbols)
