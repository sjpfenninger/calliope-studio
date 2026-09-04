"""What a comparison of two resolved models says, and what it refuses to say.

Every case here is built by mutating one solved model, so the *only* thing that
differs between the two sides is the thing under test — which is what makes an
assertion about the output meaningful rather than a description of whatever the
example model happens to contain.

The diff is what a user reads to answer "what did I change?", so the failures
that matter are the quiet ones: a change attributed to the wrong technology, a
time subset reported as thousands of changed series, a `.inf` that takes the
whole payload down, or two models that differ being called identical.
"""

import dataclasses
import json

import numpy as np
import pytest
import xarray as xr

from calliope_studio.modeldef.yaml_io import _same
from calliope_studio.results.diff import MAX_CHANGES_PER_ENTITY, model_diff, plain, same


def with_inputs(model, inputs):
    """The same model, reading different inputs."""
    return dataclasses.replace(model, inputs=inputs)


def set_value(model, name, value, **selector):
    """A copy of `model` with one cell of one input array changed."""
    inputs = model.inputs.copy(deep=True)
    inputs[name].loc[selector] = value
    return with_inputs(model, inputs)


def entities_by_name(diff, kind=None):
    return {
        entity["name"]: entity
        for entity in diff["entities"]
        if kind is None or entity["kind"] == kind
    }


def changed_params(entity):
    return {change["param"] for change in entity["changes"]}


class TestNoDifference:
    def test_a_model_against_itself_is_empty(self, results):
        """The property the whole feature rests on.

        A comparison that invents differences is worse than no comparison: the
        user goes looking for an edit they never made. This is the compare
        view's version of "a no-op save must not change the file".
        """
        diff = model_diff(results.model, results.model)
        assert diff["empty"]
        assert diff["entities"] == []
        assert diff["config"] == []
        assert diff["dims"] == []

    def test_unchanged_entities_are_counted_not_listed(self, results):
        """A list of everything that did *not* change is not a diff."""
        diff = model_diff(results.model, results.model)
        counted = sum(summary["unchanged"] for summary in diff["summary"].values())
        assert counted > 5, "the example model has several technologies and nodes"


class TestParameterChanges:
    def test_one_value_is_one_change_on_one_technology(self, results):
        """The common case: a number edited in the YAML, found and attributed."""
        after = set_value(
            results.model, "flow_cap_max", 12345.0, nodes="region1", techs="ccgt"
        )
        diff = model_diff(results.model, after)

        assert not diff["empty"]
        entities = entities_by_name(diff)
        assert set(entities) == {"ccgt"}
        entity = entities["ccgt"]
        assert entity["kind"] == "tech"
        assert entity["status"] == "changed"

        (change,) = entity["changes"]
        assert change["param"] == "flow_cap_max"
        assert change["before"] == 30000.0
        assert change["after"] == 12345.0
        # The tech is the entity, so the *node* is what says which cell moved.
        assert change["where"] == {"nodes": "region1"}

    def test_a_parameter_carries_its_generalised_unit_verbatim(self, results):
        """`power`, never kW: only the modeller knows the real unit.

        And verbatim, full stop included. Calliope's declarations are
        inconsistent — `power.` here, three alternatives separated by pipes on
        `sink_use_equals`, a `\\{cost}` typo on nine cost parameters — and
        normalising them is presentation, which `web/src/lib/units.ts` does by
        parsing. A server that tidied them here would have to guess which of
        three alternatives a parameter means, and a guess presented as a label
        is a wrong unit on a right number.
        """
        after = set_value(
            results.model, "flow_cap_max", 1.0, nodes="region1", techs="ccgt"
        )
        (change,) = entities_by_name(model_diff(results.model, after))["ccgt"][
            "changes"
        ]
        assert change["unit"] == "power."

    def test_an_ambiguous_declaration_is_passed_on_rather_than_resolved(self, results):
        """`sink_use_equals` declares three alternatives at once."""
        inputs = results.model.inputs.copy(deep=True)
        inputs["sink_use_equals"].loc[
            {"nodes": "region2", "techs": "demand_power"}
        ] *= 2
        (change,) = entities_by_name(
            model_diff(results.model, with_inputs(results.model, inputs))
        )["demand_power"]["changes"]
        assert change["unit"].count("|") == 2

    def test_a_string_parameter_is_compared_as_a_string(self, results):
        """Object-dtype arrays: `name`, `color`, `base_tech` all live here."""
        after = set_value(results.model, "name", "Renamed turbine", techs="ccgt")
        (change,) = entities_by_name(model_diff(results.model, after))["ccgt"][
            "changes"
        ]
        assert change["param"] == "name"
        assert change["before"] == "Combined cycle gas turbine"
        assert change["after"] == "Renamed turbine"

    def test_a_value_appearing_where_there_was_none_is_a_change(self, results):
        """NaN is the absence of a value, and gaining one is an edit."""
        after = set_value(
            results.model, "flow_cap_max", 500.0, nodes="region1", techs="battery"
        )
        (change,) = entities_by_name(model_diff(results.model, after))["battery"][
            "changes"
        ]
        assert change["before"] is None
        assert change["after"] == 500.0

    def test_two_nans_are_not_a_change(self, results):
        """`NaN != NaN` in IEEE, and every unset cell of every array is NaN.

        Compared naively this makes two identical models differ in thousands of
        places, which is the failure that would have made the feature useless.
        """
        assert model_diff(results.model, results.model)["empty"]

    def test_an_unbounded_value_survives_as_a_spelling(self, results):
        """`.inf` is not JSON, and `storage_cap_max` really is infinite here."""
        after = set_value(results.model, "storage_cap_max", 10.0, techs="battery")
        (change,) = entities_by_name(model_diff(results.model, after))["battery"][
            "changes"
        ]
        assert change["before"] == ".inf"
        assert change["after"] == 10.0
        # The whole point: the payload has to survive being serialised.
        json.dumps(change, allow_nan=False)

    def test_a_parameter_with_no_entity_dimension_belongs_to_the_model(self, results):
        """`bigM` is a property of the optimisation, not of any technology."""
        inputs = results.model.inputs.copy(deep=True)
        inputs["bigM"] = xr.DataArray(1e7)
        diff = model_diff(results.model, with_inputs(results.model, inputs))
        (entity,) = [e for e in diff["entities"] if e["kind"] == "model"]
        assert changed_params(entity) == {"bigM"}

    def test_a_parameter_present_on_one_side_only_is_a_change(self, results):
        """A parameter deleted from the YAML has to be visible as a loss."""
        after = with_inputs(
            results.model, results.model.inputs.drop_vars("flow_ramping")
        )
        diff = model_diff(results.model, after)
        changed = {
            change["param"]
            for entity in diff["entities"]
            for change in entity["changes"]
        }
        assert "flow_ramping" in changed


class TestTimeSeries:
    def test_a_series_is_summarised_rather_than_listed(self, results):
        """120 timesteps here; a real model has 8,760 and nobody reads them."""
        inputs = results.model.inputs.copy(deep=True)
        inputs["sink_use_equals"].loc[
            {"nodes": "region2", "techs": "demand_power"}
        ] *= 2
        diff = model_diff(results.model, with_inputs(results.model, inputs))

        (change,) = entities_by_name(diff)["demand_power"]["changes"]
        assert change["param"] == "sink_use_equals"
        assert change["where"] == {"nodes": "region2"}
        assert "before" not in change
        series = change["series"]
        assert series["total"] == results.model.inputs.sizes["timesteps"]
        assert 0 < series["changed"] <= series["total"]
        assert series["after_sum"] == pytest.approx(2 * series["before_sum"])

    def test_a_time_subset_is_one_row_not_a_change_on_every_series(self, results):
        """Solving a shorter window must not read as the whole model changing.

        Comparing values across timesteps only one side has would mark every
        series changed — thousands of rows saying one thing, which the `dims`
        row says once.
        """
        after = with_inputs(
            results.model, results.model.inputs.isel(timesteps=slice(0, 24))
        )
        diff = model_diff(results.model, after)

        (row,) = diff["dims"]
        assert row["dim"] == "timesteps"
        assert row["before"] == 120
        assert row["after"] == 24
        assert row["range"]["after"] == ["2005-01-01 00:00", "2005-01-01 23:00"]
        assert diff["entities"] == [], "the values themselves did not change"

    def test_a_change_inside_the_shared_window_still_shows(self, results):
        """The inner join must not hide a real edit in the overlap."""
        shorter = results.model.inputs.isel(timesteps=slice(0, 24)).copy(deep=True)
        shorter["sink_use_equals"].loc[
            {"nodes": "region2", "techs": "demand_power"}
        ] *= 3
        diff = model_diff(results.model, with_inputs(results.model, shorter))
        (change,) = entities_by_name(diff)["demand_power"]["changes"]
        assert change["series"]["total"] == 24


class TestEntities:
    def test_a_transmission_technology_is_a_link(self, results):
        """Calliope 0.7 has no `links:` section; a link is a tech's base tech."""
        after = set_value(
            results.model,
            "flow_cap_max",
            999.0,
            nodes="region1",
            techs="region1_to_region2",
        )
        diff = model_diff(results.model, after)
        assert entities_by_name(diff)["region1_to_region2"]["kind"] == "link"

    def test_a_technology_that_becomes_a_link_is_classified_as_one(self, results):
        """Read from either side, so a reclassification is not lost."""
        after = set_value(results.model, "base_tech", "transmission", techs="ccgt")
        diff = model_diff(results.model, after)
        entity = entities_by_name(diff)["ccgt"]
        assert entity["kind"] == "link"
        assert "base_tech" in changed_params(entity)

    def test_where_a_technology_is_defined_is_one_change(self, results):
        """The definition matrix is a set of nodes, not a grid of booleans."""
        inputs = results.model.inputs.copy(deep=True)
        inputs["active"].loc[{"nodes": "region1_1", "techs": "ccgt"}] = 1
        diff = model_diff(results.model, with_inputs(results.model, inputs))

        (change,) = entities_by_name(diff)["ccgt"]["changes"]
        assert change["param"] == "nodes"
        assert "region1_1" not in change["before"]
        assert "region1_1" in change["after"]

    def test_a_node_parameter_belongs_to_the_node(self, results):
        """A dragged node is a change to that node, not to every technology."""
        after = set_value(results.model, "latitude", 41.0, nodes="region2")
        diff = model_diff(results.model, after)
        entity = entities_by_name(diff)["region2"]
        assert entity["kind"] == "node"
        assert changed_params(entity) == {"latitude"}

    def test_a_removed_node_is_reported_once_and_names_the_dimension(self, results):
        after = with_inputs(
            results.model, results.model.inputs.drop_sel(nodes="region1_3")
        )
        diff = model_diff(results.model, after)
        assert entities_by_name(diff)["region1_3"]["status"] == "removed"
        (row,) = [row for row in diff["dims"] if row["dim"] == "nodes"]
        assert row["removed"] == ["region1_3"]

    def test_many_changes_on_one_entity_are_capped_and_the_rest_counted(self, results):
        """A truncated list must say so; silence would look like completeness."""
        wide = results.model.inputs.copy(deep=True)
        extra = MAX_CHANGES_PER_ENTITY + 10
        wide["synthetic"] = xr.DataArray(
            np.zeros((extra, wide.sizes["techs"])),
            dims=("scratch", "techs"),
            coords={
                "scratch": [f"s{index}" for index in range(extra)],
                "techs": wide["techs"].values,
            },
        )
        before = with_inputs(results.model, wide)
        changed = wide.copy(deep=True)
        changed["synthetic"].loc[{"techs": "ccgt"}] = 1.0
        after = with_inputs(results.model, changed)

        entity = entities_by_name(model_diff(before, after))["ccgt"]
        assert len(entity["changes"]) == MAX_CHANGES_PER_ENTITY
        assert entity["truncated"] == 10


class TestConfig:
    def test_a_changed_setting_is_reported_by_its_dotted_path(self, results):
        model = results.model
        after = dataclasses.replace(
            model, config={**model.config, "build": {"ensure_feasibility": False}}
        )
        diff = model_diff(model, after)
        assert diff["config"] == [
            {"path": "build.ensure_feasibility", "before": True, "after": False}
        ]
        assert not diff["empty"]

    def test_no_config_on_one_side_is_every_setting_gained_not_a_nameless_row(
        self, results
    ):
        """An older `.nc` carries no `config` attr, and `{}` flattened to `{"": {}}`.

        That put a row with an empty path in the table and made a pair that
        was otherwise identical read as different.
        """
        model = results.model
        bare = dataclasses.replace(model, config={})
        rows = model_diff(bare, model)["config"]

        assert rows and all(row["path"] for row in rows)
        assert all(row["before"] is None for row in rows)
        assert model_diff(bare, bare)["empty"]

    def test_a_setting_gained_or_lost_is_reported(self, results):
        """A key on one side only reads as null on the other, not as absent."""
        model = results.model
        after = dataclasses.replace(
            model, config={**model.config, "solve": {"solver": "glpk"}}
        )
        paths = {row["path"]: row for row in model_diff(model, after)["config"]}

        assert paths["solve.solver"] == {
            "path": "solve.solver",
            "before": "cbc",
            "after": "glpk",
        }
        # `zero_threshold` was in the original block and is not in the new one.
        assert paths["solve.zero_threshold"]["after"] is None

    @pytest.mark.parametrize(
        ("before", "after", "reported"),
        [
            (40, 40, False),
            (40, 40.0, True),
            (True, 1, True),
            ("x", "x", False),
            ({"a": 1}, {"a": 1}, False),
            ({"a": 1}, {"a": 2}, True),
        ],
    )
    def test_type_strict_comparison(self, results, before, after, reported):
        """`40` and `40.0` are different YAML, and `true` is not `1`."""
        model = results.model
        left = dataclasses.replace(model, config={"init": {"value": before}})
        right = dataclasses.replace(model, config={"init": {"value": after}})
        assert bool(model_diff(left, right)["config"]) is reported


class TestEquality:
    @pytest.mark.parametrize(
        ("left", "right"),
        [
            (40, 40),
            (40.0, 40.0),
            (True, True),
            ("a", "a"),
            (None, None),
            ({"a": [1, 2]}, {"a": [1, 2]}),
            ({"a": 1, "b": 2}, {"b": 2, "a": 1}),
        ],
    )
    def test_agrees_with_the_editor_on_what_is_unchanged(self, left, right):
        """`same` is a twin of `yaml_io._same`, which `results` may not import.

        Two implementations of one question drift, and this is the seam that
        catches it. Only the cases where both must agree: `_same` deliberately
        forgives an int arriving where the file holds an integral float,
        because JSON cannot say "the float 29" — a leniency that has no meaning
        here, where both sides come from Calliope.
        """
        assert same(left, right) is True
        assert _same(left, right) is True

    @pytest.mark.parametrize(
        ("left", "right"),
        [
            (True, 1),
            (1, True),
            (40.0, "40.0"),
            ({"a": 1}, {"a": 2}),
            ({"a": 1}, {"a": 1, "b": 2}),
            ([1, 2], [2, 1]),
        ],
    )
    def test_agrees_with_the_editor_on_what_is_changed(self, left, right):
        assert same(left, right) is False
        assert _same(left, right) is False

    def test_two_absences_are_the_same_absence(self):
        """NaN is how an unset value arrives out of an array."""
        assert same(float("nan"), float("nan"))


class TestPlain:
    @pytest.mark.parametrize(
        ("value", "expected"),
        [
            (np.float64(1.5), 1.5),
            (np.int64(3), 3),
            (np.str_("x"), "x"),
            (float("inf"), ".inf"),
            (float("-inf"), "-.inf"),
            (float("nan"), None),
            (np.bool_(True), True),
        ],
    )
    def test_values_arrive_as_something_json_can_carry(self, value, expected):
        converted = plain(value)
        assert converted == expected
        json.dumps(converted, allow_nan=False)

    def test_the_whole_payload_is_serialisable(self, results):
        """One non-finite value would take the payload down, not one field."""
        after = set_value(results.model, "storage_cap_max", 1.0, techs="battery")
        json.dumps(model_diff(results.model, after), allow_nan=False)
