"""Overrides as a flat list of settings.

An override is an arbitrary partial model, so the editor shows it as one row per
leaf rather than as a form. The property that carries the whole design is that
*displaying flattened must not mean writing flattened*: editing one setting has to
leave the rest of the file — its structure, its spelling and its comments —
exactly as it was.

The dotted display is inherently ambiguous, because Calliope accepts
`config.init.mode` written as three nested keys, as `config.init:` containing
`mode:`, or as one key `config.init.mode:`. Most of these tests exist to pin down
that whichever spelling the file uses is the one that gets edited.
"""

import pytest

from calligraph.modeldef.imports import component_tree
from calligraph.modeldef.overrides import (
    describe,
    flatten,
    is_value,
    set_path,
    unset_path,
)
from calligraph.modeldef.yaml_io import read_section, write_section


class TestFlatten:
    def test_nested_mappings_become_dotted_paths(self):
        assert flatten(
            {"config": {"init": {"name": "x", "subset": {"timesteps": ["a", "b"]}}}}
        ) == {"config.init.name": "x", "config.init.subset.timesteps": ["a", "b"]}

    def test_dotted_keys_are_joined_the_same_way(self):
        """`config.init:` and three nested keys must display identically."""
        nested = flatten({"config": {"init": {"mode": "spores"}}})
        dotted = flatten({"config.init": {"mode": "spores"}})
        single = flatten({"config.init.mode": "spores"})
        assert nested == dotted == single == {"config.init.mode": "spores"}

    def test_order_is_preserved(self):
        flat = flatten({"b": {"z": 1, "a": 2}, "a": 3})
        assert list(flat) == ["b.z", "b.a", "a"]

    def test_a_null_value_is_a_setting(self):
        """`subset: {timesteps: null}` means "no subsetting", not "unset"."""
        assert flatten({"config": {"init": {"subset": {"timesteps": None}}}}) == {
            "config.init.subset.timesteps": None
        }

    def test_an_empty_mapping_is_a_leaf(self):
        """Descending into it would lose the setting entirely."""
        assert flatten({"techs": {}}) == {"techs": {}}

    def test_an_indexed_parameter_stays_one_setting(self):
        """Splitting it would let a user edit `index` without `data`.

        `spores_tracker` is a single parameter value, not three settings.
        """
        tracker = {"data": [True, True, True], "index": ["ccgt"], "dims": "techs"}
        assert flatten({"data_definitions": {"spores_tracker": tracker}}) == {
            "data_definitions.spores_tracker": tracker
        }

    def test_a_data_table_stays_one_setting(self):
        table = {"data": "data_tables/cluster_days.csv", "rows": "datesteps"}
        assert flatten({"data_tables": {"cluster_days": table}}) == {
            "data_tables.cluster_days": table
        }

    @pytest.mark.parametrize("value", [1, "x", None, [1, 2], {}, {"data": 1}])
    def test_is_value_agrees_with_flatten(self, value):
        assert is_value(value) is (flatten({"k": value}) == {"k": value})


class TestSetPathDoesNotReshape:
    def test_an_existing_nested_leaf_is_set_in_place(self):
        document = {"config": {"init": {"name": "old"}}}
        set_path(document, "config.init.name", "new")
        assert document == {"config": {"init": {"name": "new"}}}

    def test_a_dotted_key_keeps_its_spelling(self):
        """The file said `config.init:`, so it must not gain a nested `config:`."""
        document = {"config.init": {"mode": "spores"}}
        set_path(document, "config.init.mode", "plan")
        assert document == {"config.init": {"mode": "plan"}}

    def test_a_single_dotted_leaf_keeps_its_spelling(self):
        document = {"config.init.mode": "spores"}
        set_path(document, "config.init.mode", "plan")
        assert document == {"config.init.mode": "plan"}

    def test_the_longest_existing_key_wins(self):
        """Both spellings present: edit the most specific one, invent neither."""
        document = {"config": {"build": {}}, "config.init": {"mode": "spores"}}
        set_path(document, "config.init.mode", "plan")
        assert document == {"config": {"build": {}}, "config.init": {"mode": "plan"}}

    def test_a_new_leaf_in_an_existing_container_does_not_disturb_it(self):
        document = {"config": {"init": {"name": "x"}}}
        set_path(document, "config.init.mode", "plan")
        assert document == {"config": {"init": {"name": "x", "mode": "plan"}}}

    def test_a_new_branch_is_created_nested(self):
        document = {"config": {"init": {"name": "x"}}}
        set_path(document, "config.solve.solver", "cbc")
        assert document == {
            "config": {"init": {"name": "x"}, "solve": {"solver": "cbc"}}
        }

    def test_a_wholly_new_path_is_created(self):
        document: dict = {}
        set_path(document, "techs.ccgt.flow_cap_max", 100)
        assert document == {"techs": {"ccgt": {"flow_cap_max": 100}}}

    def test_a_value_is_never_silently_turned_into_a_container(self):
        """`config.init` holds a string; setting below it must not destroy it.

        Refused rather than worked around: a model cannot have `init` be both a
        string and a mapping, so any way of writing this produces something
        contradictory. Better to say so.
        """
        document = {"config": {"init": "not a mapping"}}
        with pytest.raises(ValueError, match="already holds a value"):
            set_path(document, "config.init.mode", "plan")
        assert document == {"config": {"init": "not a mapping"}}

    def test_an_indexed_parameter_is_replaced_whole(self):
        document = {"data_definitions": {"t": {"data": [1], "dims": "techs"}}}
        set_path(document, "data_definitions.t", {"data": [2], "dims": "nodes"})
        assert document == {"data_definitions": {"t": {"data": [2], "dims": "nodes"}}}

    def test_an_empty_path_is_rejected(self):
        with pytest.raises(ValueError):
            set_path({}, "", 1)


class TestUnsetPath:
    def test_a_leaf_is_removed(self):
        document = {"config": {"init": {"name": "x", "mode": "plan"}}}
        unset_path(document, "config.init.mode")
        assert document == {"config": {"init": {"name": "x"}}}

    def test_a_dotted_leaf_is_removed(self):
        document = {"config.init": {"mode": "plan"}}
        unset_path(document, "config.init.mode")
        assert document == {"config.init": {}}

    def test_removing_something_absent_is_harmless(self):
        document = {"config": {"init": {"name": "x"}}}
        unset_path(document, "config.solve.solver")
        assert document == {"config": {"init": {"name": "x"}}}


class TestFileFidelity:
    """flatten → edit one leaf → write must leave every other line untouched.

    The same golden-corpus property the section editors already have to satisfy,
    and the reason `set_path` resolves against the file rather than imposing a
    structure.

    Note the `settled` fixture. A file's *first* save through ruamel normalises a
    few spellings ruamel does not model — `False` to `false`, an explicit `null` to
    nothing, flow-mapping padding — all of which are invisible to a YAML parser.
    `test_yaml_io.assert_faithful_rewrite` documents them and `TestGoldenCorpus`
    covers them for every section of both example models. Measuring an edit from an
    already-settled file is what makes these assertions about `set_path` rather
    than about that one-off reformatting.
    """

    @pytest.fixture
    def settled(self, national_scale):
        """`scenarios.yaml`, already through one save, so only edits show up."""
        path = national_scale / "scenarios.yaml"
        write_section(path, "overrides", read_section(path, "overrides"))
        return path

    def test_a_no_op_write_is_byte_identical(self, settled):
        """A save with no edits must never change the file."""
        before = settled.read_bytes()
        write_section(settled, "overrides", read_section(settled, "overrides"))
        assert settled.read_bytes() == before

    def test_editing_one_setting_changes_exactly_one_line(self, settled):
        before = settled.read_text().splitlines()

        section = read_section(settled, "overrides")
        set_path(section["time_resampling"], "config.init.resample.timesteps", "12h")
        write_section(settled, "overrides", section)

        after = settled.read_text().splitlines()
        assert len(before) == len(after), "line count changed"
        changed = [(old, new) for old, new in zip(before, after) if old != new]
        assert len(changed) == 1, changed
        assert "12h" in changed[0][1]

    def test_adding_a_setting_adds_exactly_one_line(self, settled):
        before = settled.read_text().splitlines()

        section = read_section(settled, "overrides")
        set_path(section["time_resampling"], "config.solve.solver", "glpk")
        write_section(settled, "overrides", section)

        after = settled.read_text().splitlines()
        assert len(after) == len(before) + 2  # the new `solve:` group and its key
        assert any("glpk" in line for line in after)

    def test_comments_survive(self, settled):
        def comments(text):
            return [line for line in text.splitlines() if line.strip().startswith("#")]

        before = comments(settled.read_text())

        section = read_section(settled, "overrides")
        set_path(section["profiling"], "config.solve.solver", "glpk")
        write_section(settled, "overrides", section)

        assert comments(settled.read_text()) == before

    def test_a_dotted_key_in_a_real_model_stays_dotted(self, settled):
        """`spores` is written with `config.init:` and `config.solve.spores:`."""
        section = read_section(settled, "overrides")
        set_path(section["spores"], "config.solve.spores.number", 7)
        write_section(settled, "overrides", section)

        text = settled.read_text()
        assert "config.solve.spores:" in text
        assert "number: 7" in text
        # No second, nested spelling of the same thing.
        assert "\n      solve:\n" not in text

    def test_flatten_round_trips_a_real_override(self, national_scale):
        """Every setting displayed can be written back to where it came from."""
        section = read_section(national_scale / "scenarios.yaml", "overrides")
        for name, body in section.items():
            flat = flatten(body)
            rebuilt = dict(body)
            for setting_path, value in flat.items():
                set_path(rebuilt, setting_path, value)
            assert rebuilt == body, name


class TestDescribe:
    def test_every_override_is_described(self, national_scale):
        section = read_section(national_scale / "scenarios.yaml", "overrides")
        described = describe(section)

        assert set(described) == set(section)
        spores = {row["path"] for row in described["spores"]}
        assert "config.init.mode" in spores
        assert "data_definitions.spores_tracker" in spores


class TestComponentTreeSummaries:
    """The explorer should say something useful before anything is opened."""

    def test_an_override_reports_how_many_settings_it_makes(self, national_scale):
        tree = component_tree(national_scale)
        entry = next(
            item for item in tree["overrides"]["entries"] if item["name"] == "spores"
        )
        assert entry["setting_count"] > 1

    def test_a_scenario_reports_the_overrides_it_composes(self, national_scale):
        tree = component_tree(national_scale)
        entry = next(
            item
            for item in tree["scenarios"]["entries"]
            if item["name"] == "cold_fusion_with_production_share"
        )
        assert entry["overrides"] == ["cold_fusion", "cold_fusion_prod_share"]
