"""Which math a model declares, and which of it Calliope will actually apply.

The distinction these tests exist for is that **declaring a math file and
enabling it are two separate acts**. `config.init.math_paths` registers a name;
`config.init.extra_math` applies it. Calliope says nothing at all about a file
registered and never applied — from its point of view you simply did not ask —
so a user can write a constraint, wire in the file, run the model and get exactly
the same answer as before with nothing anywhere to explain why. That is what
`applied: false` is for, and it is the reason this module exists rather than a
few lines inside `imports`.

The path-resolution tests are a real defect, not a hypothetical: Calliope
resolves `math_paths` against the root `model.yaml`, and both callers here used
to resolve against the file that declares the entry. Declared one level down that
meant the math file was validated against the wrong schema *and* left out of the
run snapshot — which makes the frozen model unbuildable, so a run that would have
worked fails.
"""

import pytest

from calliope_studio.modeldef import snapshot
from calliope_studio.modeldef.filekinds import MATH, classify
from calliope_studio.modeldef.imports import component_tree
from calliope_studio.modeldef.mathdef import (
    BUILTIN,
    MALFORMED,
    UNKNOWN,
    USER,
    builtin_math_names,
    math_components,
    math_sources,
)

MATH_FILE = """\
constraints:
  my_limit:
    description: A limit of my own.
    foreach: [nodes, techs]
    where: flow_cap_max
    equations:
      - expression: flow_cap <= flow_cap_max
"""


def register(model_yaml, name, path, *, enable=True):
    """Adds a `math_paths` entry, and optionally enables it.

    Writes the YAML by hand rather than round-tripping it: these tests are about
    what the reader makes of a file, so the file has to be the fixture.
    """
    text = model_yaml.read_text()
    marker = "    math_paths:\n"
    if marker in text:
        text = text.replace(marker, f'{marker}      {name}: "{path}"\n', 1)
    else:
        text = text.replace(
            "  init:\n", f'  init:\n    math_paths:\n      {name}: "{path}"\n', 1
        )
    if enable:
        if "extra_math:" in text:
            text = text.replace('extra_math: ["', f'extra_math: ["{name}", "', 1)
        else:
            text = text.replace(
                "  init:\n", f'  init:\n    extra_math: ["{name}"]\n', 1
            )
    model_yaml.write_text(text)


class TestSources:
    def test_a_model_with_no_custom_math_has_only_base(self, national_scale):
        """The floor. `base` is always applied and is never the user's."""
        sources = math_sources(national_scale)

        assert [source["name"] for source in sources] == ["base"]
        assert sources[0] == {"name": "base", "applied": True, "kind": BUILTIN}

    def test_declared_and_enabled_math_is_applied_last(self, urban_scale):
        """Priority order is base → mode → extra, and later definitions win.

        The order is the whole meaning of the list: a component defined twice is
        whatever the *last* source says, so presenting these unordered would be
        presenting the wrong formulation.
        """
        sources = math_sources(urban_scale)

        assert [source["name"] for source in sources] == ["base", "additional_math"]
        additional = sources[-1]
        assert additional["kind"] == USER
        assert additional["applied"] is True
        assert additional["path"] == "additional_math.yaml"
        assert additional["file"] == "model.yaml"
        assert additional["line"] is not None
        assert additional["counts"] == {"parameters": 1, "constraints": 2}

    def test_declared_but_not_enabled_is_reported_as_such(self, national_scale):
        """The silent failure this module is mostly here to prevent.

        Registering a file and forgetting `extra_math` produces a model that
        reads, builds, solves and ignores every line of math in it, with no
        warning from Calliope and nothing on screen to say so.
        """
        (national_scale / "my_math.yaml").write_text(MATH_FILE)
        register(national_scale / "model.yaml", "mine", "my_math.yaml", enable=False)

        sources = {source["name"]: source for source in math_sources(national_scale)}

        assert sources["mine"]["applied"] is False
        assert sources["mine"]["kind"] == USER
        # Still counted: what it *would* contribute is the reason to enable it.
        assert sources["mine"]["counts"] == {"constraints": 1}

    def test_a_declared_file_that_is_not_there_is_flagged(self, national_scale):
        register(national_scale / "model.yaml", "mine", "nowhere.yaml")

        source = next(s for s in math_sources(national_scale) if s["name"] == "mine")

        assert source["missing"] is True
        assert source["counts"] == {}
        # The path is still reported as written, because that is the thing to fix.
        assert source["path"] == "nowhere.yaml"

    def test_taking_a_builtin_name_is_flagged_as_shadowing(self, national_scale):
        """`math_paths: {base: …}` replaces Calliope's entire base math.

        `initialise_math` keys the pool by name and only logs a warning, so a
        user who reaches for an obvious name silently loses every constraint
        Calliope ships. Legitimate to do deliberately; catastrophic by accident.
        """
        (national_scale / "my_math.yaml").write_text(MATH_FILE)
        register(national_scale / "model.yaml", "base", "my_math.yaml", enable=False)

        source = next(s for s in math_sources(national_scale) if s["name"] == "base")

        assert source["shadows_builtin"] is True
        assert source["kind"] == USER
        assert source["applied"] is True  # `base` is always applied

    def test_enabling_a_name_nothing_defines_is_unknown(self, national_scale):
        """Calliope raises `Requested math 'x' was not initialised.` on read.

        Reported from the YAML so the user sees it in the tree, rather than
        spending a subprocess and a stack trace to find out.
        """
        model_yaml = national_scale / "model.yaml"
        model_yaml.write_text(
            model_yaml.read_text().replace(
                "  init:\n", '  init:\n    extra_math: ["ghost"]\n', 1
            )
        )

        source = next(s for s in math_sources(national_scale) if s["name"] == "ghost")

        assert source["kind"] == UNKNOWN
        assert source["applied"] is True

    def test_extra_math_written_as_a_bare_name_is_reported_not_spelled_out(
        self, national_scale
    ):
        """A string is iterable, and `extra_math: mine` used to yield m, i, n, e.

        Four bogus `unknown` sources in the tree, and the one the user meant
        nowhere — for the ordinary shape of the typo, in the module whose job
        is to explain why math is not being applied.
        """
        model = national_scale / "model.yaml"
        model.write_text(
            model.read_text().replace("  init:\n", "  init:\n    extra_math: mine\n", 1)
        )

        sources = math_sources(national_scale)

        names = [source["name"] for source in sources]
        assert "m" not in names and "mine" not in names
        problem = next(source for source in sources if source["kind"] == MALFORMED)
        assert problem["name"] == "extra_math"
        assert problem["applied"] is False
        assert "must be a list" in problem["problem"]

    def test_math_paths_written_as_a_list_is_reported_not_ignored(self, national_scale):
        (national_scale / "my_math.yaml").write_text(MATH_FILE)
        model = national_scale / "model.yaml"
        model.write_text(
            model.read_text().replace(
                "  init:\n", "  init:\n    math_paths:\n      - my_math.yaml\n", 1
            )
        )

        sources = math_sources(national_scale)

        problem = next(source for source in sources if source["kind"] == MALFORMED)
        assert problem["name"] == "math_paths"
        assert "model.yaml" in problem["problem"]
        assert not any(source["kind"] == USER for source in sources)

    def test_mode_math_is_applied_between_base_and_extra(self, national_scale):
        """Calliope's own order, and the one place a mode changes the math."""
        model_yaml = national_scale / "model.yaml"
        model_yaml.write_text(
            model_yaml.read_text().replace("mode: base", "mode: operate", 1)
        )
        (national_scale / "my_math.yaml").write_text(MATH_FILE)
        register(model_yaml, "mine", "my_math.yaml")

        assert [s["name"] for s in math_sources(national_scale)] == [
            "base",
            "operate",
            "mine",
        ]

    def test_builtin_names_come_from_calliope(self):
        """Read from `calliope/math/`, so a new one needs no edit here.

        `base` first because `modeldef.schema` merges in this order and takes the
        first definition of a name.
        """
        names = builtin_math_names()

        assert names[0] == "base"
        assert {"milp", "operate", "spores"} <= set(names)


class TestPathResolution:
    """Where a `math_paths` entry points, when it is not in the root file.

    Calliope hands `initialise_math` the `definition_path` it was given — the
    entry-point `model.yaml`, which only ever lives at the workspace root — so a
    relative math path means something different from every other relative path
    in the same file.
    """

    @pytest.fixture
    def declared_from_a_subfolder(self, national_scale):
        (national_scale / "math").mkdir()
        (national_scale / "math" / "mine.yaml").write_text(MATH_FILE)
        imported = national_scale / "model_config" / "techs.yaml"
        imported.write_text(
            'config:\n  init:\n    math_paths:\n      mine: "math/mine.yaml"\n'
            '    extra_math: ["mine"]\n\n' + imported.read_text()
        )
        return national_scale

    def test_the_source_is_found(self, declared_from_a_subfolder):
        source = next(
            s for s in math_sources(declared_from_a_subfolder) if s["name"] == "mine"
        )

        assert source["path"] == "math/mine.yaml"
        assert source["file"] == "model_config/techs.yaml"
        assert not source.get("missing")

    def test_it_gets_the_math_schema(self, declared_from_a_subfolder):
        """Otherwise every key in it reads as unknown in the editor."""
        assert classify(declared_from_a_subfolder)["math/mine.yaml"] == MATH

    def test_it_is_captured_in_a_run_snapshot(self, declared_from_a_subfolder):
        """The one that fails a run rather than merely annoying somebody.

        A snapshot missing a math file is not a buildable model, so the frozen
        tree the worker solves from is broken while the live workspace is fine.
        """
        collected = snapshot.collect(declared_from_a_subfolder)

        assert "math/mine.yaml" in collected.files
        assert collected.complete


class TestComponents:
    def test_user_components_carry_their_declaring_line(self, urban_scale):
        """So the Math tab can offer "go to where this is written".

        The rendered math knows which *source* a component came from; by then it
        is a parsed pydantic model and the file and line are gone.
        """
        components = math_components(urban_scale)

        assert set(components) == {"parameters", "constraints"}
        chp = components["constraints"]["link_chp_outputs"]
        assert chp["source"] == "additional_math"
        assert chp["file"] == "additional_math.yaml"
        assert chp["line"] > 1

    def test_builtin_math_contributes_nothing(self, national_scale):
        """There is no file in the workspace to open for a base constraint."""
        assert math_components(national_scale) == {}


class TestComponentTree:
    def test_math_is_a_group_like_any_other(self, urban_scale):
        """Same `{file, entries}` shape, so the explorer needs no special case.

        It cannot come from the loop over `TREE_SECTIONS`, though: `math:` is not
        a section of a model definition, and the files are ones the import graph
        cannot see.
        """
        tree = component_tree(urban_scale)

        assert set(tree["math"]) == {"file", "entries"}
        assert tree["math"]["file"] == "model.yaml"
        assert [entry["name"] for entry in tree["math"]["entries"]] == [
            "base",
            "additional_math",
        ]

    def test_a_workspace_with_no_model_has_no_math_group(self, tmp_path):
        """An empty folder must not claim to apply Calliope's base math."""
        assert component_tree(tmp_path) == {}
