"""Comment-preserving YAML round-trip.

The editor's whole premise is that editing one section through a form leaves the
rest of the file exactly as the user wrote it. These are the tests that hold
that promise, so they are deliberately strict: byte comparison, not semantic.
"""

import json
import math
from pathlib import Path

import pytest

from calliope_studio.modeldef.paths import yaml_files
from calliope_studio.modeldef.yaml_io import (
    SectionNotFound,
    _round_trip_yaml,
    from_plain,
    load,
    read_section,
    to_plain,
    write_section,
)

SAMPLE = """\
# Leading comment about the model
config:
  init:
    name: Test model  # trailing comment
    time_subset: ["2005-01-01", "2005-01-05"]

# A comment between sections
techs:
  battery:
    base_tech: storage
    flow_cap_max: .inf
"""


@pytest.fixture
def sample_file(tmp_path: Path) -> Path:
    path = tmp_path / "model.yaml"
    path.write_text(SAMPLE)
    return path


class TestRoundTrip:
    def test_rewriting_a_section_unchanged_is_byte_identical(self, sample_file):
        original = sample_file.read_text()
        write_section(sample_file, "techs", read_section(sample_file, "techs"))
        assert sample_file.read_text() == original

    def test_editing_one_section_leaves_the_others_untouched(self, sample_file):
        techs = read_section(sample_file, "techs")
        techs["battery"]["flow_cap_max"] = 100
        write_section(sample_file, "techs", techs)

        text = sample_file.read_text()
        assert "# Leading comment about the model" in text
        assert "# trailing comment" in text
        assert "# A comment between sections" in text
        assert "flow_cap_max: 100" in text
        # Ordering and quote style outside the edited section survive.
        assert text.index("config:") < text.index("techs:")
        assert '["2005-01-01", "2005-01-05"]' in text

    def test_missing_section_raises(self, sample_file):
        with pytest.raises(SectionNotFound):
            read_section(sample_file, "nodes")
        with pytest.raises(SectionNotFound):
            write_section(sample_file, "nodes", {})


class TestToPlain:
    def test_infinity_travels_as_its_yaml_spelling(self, sample_file):
        """`.inf` has to survive a JSON round trip, which cannot carry a float.

        It used to become `None`, which reached the editor as an *empty* field —
        and the editors drop empty values, so opening the techs editor and
        pressing Save deleted every `.inf` line in the user's file. Carrying the
        YAML spelling instead means the field shows `.inf`, which is both what
        the file says and what someone would type to mean it.
        """
        techs = read_section(sample_file, "techs")
        assert techs["battery"]["flow_cap_max"] == ".inf"

    def test_nested_containers_become_plain_types(self, sample_file):
        document = to_plain(load(sample_file))
        assert type(document) is dict
        assert type(document["config"]["init"]["time_subset"]) is list

    def test_finite_floats_survive(self):
        assert to_plain(1.5) == 1.5
        assert to_plain(float("nan")) == ".nan"
        assert to_plain(-math.inf) == "-.inf"

    def test_the_spellings_convert_back(self):
        assert from_plain(".inf") == math.inf
        assert from_plain("-.inf") == -math.inf
        assert math.isnan(from_plain(".nan"))

    def test_only_the_exact_spellings_convert(self):
        # A general "parse anything numeric-looking" would eventually mangle a
        # technology named after a number, or a unit string.
        assert from_plain("inf") == "inf"
        assert from_plain("1.5") == "1.5"
        assert from_plain(None) is None

    def test_an_unbounded_parameter_survives_a_no_op_save(self, sample_file):
        """The whole point: read a section, write it straight back, lose nothing.

        This is the failure the browser check found — `area_use_max: .inf` and
        `storage_cap_max: .inf` vanished from `techs.yaml` the first time anyone
        pressed Save.
        """
        before = sample_file.read_text()
        write_section(sample_file, "techs", read_section(sample_file, "techs"))

        assert ".inf" in sample_file.read_text()
        assert_faithful_rewrite(before, sample_file.read_text(), "techs round trip")


def _comments(text: str) -> list[str]:
    """Every comment in a document, in order, normalised for indentation."""
    found = []
    for line in text.splitlines():
        _, marker, comment = line.partition("#")
        if marker:
            found.append(comment.strip())
    return found


def assert_faithful_rewrite(before: str, after: str, context: str) -> None:
    """Asserts a rewrite preserved everything that matters to a user.

    Byte identity is not achievable in general: ruamel normalises some scalar
    spellings when it re-emits them (`True` to `true`, an explicit `null` to
    nothing, flow-mapping spacing). Those are invisible to any YAML parser,
    including Calliope's. What must not change is the content, its order, the
    comments, or the shape of the file.
    """
    assert _comments(before) == _comments(after), f"comments changed in {context}"
    assert len(before.splitlines()) == len(after.splitlines()), (
        f"line count changed in {context} — content was reflowed"
    )

    before_doc = _round_trip_yaml().load(before)
    after_doc = _round_trip_yaml().load(after)
    assert to_plain(before_doc) == to_plain(after_doc), f"content changed in {context}"
    assert list(before_doc) == list(after_doc), f"key order changed in {context}"


def _each_section(model_dir: Path):
    for path in yaml_files(model_dir):
        document = load(path)
        if isinstance(document, dict):
            for section in list(document):
                yield path, section


class TestGoldenCorpus:
    """Every YAML file in a real model must survive a no-op section rewrite."""

    @pytest.mark.parametrize("model", ["national_scale", "urban_scale"])
    def test_sections_round_trip_faithfully(self, model, request):
        model_dir = request.getfixturevalue(model)
        checked = 0
        for path, section in _each_section(model_dir):
            original = path.read_text()
            write_section(path, section, read_section(path, section))
            assert_faithful_rewrite(
                original, path.read_text(), f"'{section}' in {path.name}"
            )
            checked += 1
        assert checked > 0, f"{model} produced no sections to check"

    def test_rewriting_is_idempotent(self, national_scale):
        """A second rewrite must be byte-identical to the first."""
        for path, section in _each_section(national_scale):
            write_section(path, section, read_section(path, section))
            settled = path.read_text()
            write_section(path, section, read_section(path, section))
            assert path.read_text() == settled, (
                f"rewriting '{section}' in {path.name} is not a fixed point"
            )

    def test_long_expressions_are_not_wrapped(self, urban_scale):
        """Math expressions must not be folded across lines by the emitter."""
        path = urban_scale / "additional_math.yaml"
        write_section(path, "constraints", read_section(path, "constraints"))
        for line in path.read_text().splitlines():
            assert not line.rstrip().endswith("=="), (
                f"expression was wrapped mid-operator: {line!r}"
            )


def _over_the_wire(path: Path, section: str):
    """A section as the frontend sends it back: through JSON and no further.

    The pure-Python round trip these tests otherwise use hands ruamel its own
    objects back, so it cannot see the class of damage that only appears once a
    value has been a JSON number. Every structured editor makes this hop.
    """
    return json.loads(json.dumps(read_section(path, section)))


class TestSpellingSurvivesTheWire:
    """A no-op save must not renormalise numbers the user never touched.

    `_merge` ended `return new` for every scalar, so a value that had been
    through JSON was no longer ruamel's `ScalarFloat`/`ScalarInt` and was
    re-emitted in the emitter's preferred style. Every one of these was verified
    against Calliope's own example models: `bigM: 1e6` became `1000000.0`, and
    `0.10`, `25.00` and `0xFF` all lost their spelling — in entries nobody had
    opened, let alone edited.
    """

    SPELLINGS = """\
config:
  build:
    bigM: 1e6
techs:
  ccgt:
    lifetime: 25.00
    area_use_max: 0xFF
    interest: 0.10
    exponent: 1.5e-3
    enabled: true
    flow_cap_max: .inf
"""

    @pytest.fixture
    def spellings(self, tmp_path: Path) -> Path:
        path = tmp_path / "spellings.yaml"
        path.write_text(self.SPELLINGS, encoding="utf-8")
        return path

    @pytest.mark.parametrize("section", ["config", "techs"])
    def test_a_no_op_save_is_byte_identical(self, spellings, section):
        write_section(spellings, section, _over_the_wire(spellings, section))
        assert spellings.read_text(encoding="utf-8") == self.SPELLINGS

    def test_editing_one_key_leaves_the_others_spelled_as_written(self, spellings):
        data = _over_the_wire(spellings, "techs")
        data["ccgt"]["lifetime"] = 30
        write_section(spellings, "techs", data)

        text = spellings.read_text(encoding="utf-8")
        assert "lifetime: 30" in text
        assert "area_use_max: 0xFF" in text
        assert "interest: 0.10" in text
        assert "exponent: 1.5e-3" in text

    def test_a_boolean_turned_into_a_number_is_still_an_edit(self, spellings):
        """`True == 1` in Python, so a plain equality check would skip this."""
        data = _over_the_wire(spellings, "techs")
        data["ccgt"]["enabled"] = 1
        write_section(spellings, "techs", data)
        assert "enabled: 1" in spellings.read_text(encoding="utf-8")

    @pytest.mark.parametrize("model", ["national_scale", "urban_scale"])
    def test_the_golden_corpus_survives_the_wire(self, model, request):
        """The same corpus check as above, with the JSON hop the editors make.

        `national_scale/model.yaml` and `urban_scale/model.yaml` both fail this
        without the guard: each carries a `bigM: 1e6` and a `0.10`.
        """
        model_dir = request.getfixturevalue(model)
        for path, section in _each_section(model_dir):
            # Measured from an already-settled file, per `assert_faithful_rewrite`:
            # a bare ruamel load/dump normalises flow-mapping padding whatever the
            # merge does, and that is not what is under test here.
            write_section(path, section, read_section(path, section))
            settled = path.read_text(encoding="utf-8")

            write_section(path, section, _over_the_wire(path, section))
            assert path.read_text(encoding="utf-8") == settled, (
                f"'{section}' in {path.name} was rewritten by a no-op save"
            )


class TestAnchors:
    """Two keys sharing an anchor are one object, and merging into it hits both.

    `_merge` recursed into the container it found, so editing `ccgt2` below
    changed `ccgt` as well — the user edits one technology and two change, and
    `to_plain` flattens the alias on the way out so nothing upstream can tell.
    Same failure class as `mergeIntoSection` deleting half a model.
    """

    ANCHORED = """\
techs:
  ccgt: &common
    base_tech: supply   # a comment
    flow_cap_max: .inf
  ccgt2: *common
  chp:
    base_tech: conversion
"""

    @pytest.fixture
    def anchored(self, tmp_path: Path) -> Path:
        path = tmp_path / "anchored.yaml"
        path.write_text(self.ANCHORED, encoding="utf-8")
        return path

    def test_a_no_op_save_keeps_the_alias(self, anchored):
        write_section(anchored, "techs", _over_the_wire(anchored, "techs"))
        assert anchored.read_text(encoding="utf-8") == self.ANCHORED

    def test_editing_one_end_leaves_the_other_alone(self, anchored):
        data = _over_the_wire(anchored, "techs")
        data["ccgt2"]["base_tech"] = "conversion"
        write_section(anchored, "techs", data)

        after = read_section(anchored, "techs")
        assert after["ccgt2"]["base_tech"] == "conversion"
        assert after["ccgt"]["base_tech"] == "supply"
        assert after["ccgt2"]["flow_cap_max"] == ".inf"

    def test_editing_the_anchor_holder_leaves_the_alias_alone(self, anchored):
        data = _over_the_wire(anchored, "techs")
        data["ccgt"]["base_tech"] = "conversion"
        write_section(anchored, "techs", data)

        after = read_section(anchored, "techs")
        assert after["ccgt"]["base_tech"] == "conversion"
        assert after["ccgt2"]["base_tech"] == "supply"

    def test_an_unrelated_edit_does_not_touch_either(self, anchored):
        data = _over_the_wire(anchored, "techs")
        data["chp"]["base_tech"] = "storage"
        write_section(anchored, "techs", data)

        after = read_section(anchored, "techs")
        assert after["ccgt"] == after["ccgt2"]
        assert "*common" in anchored.read_text(encoding="utf-8")


class TestSequences:
    """A list whose length changed used to be replaced wholesale.

    `_merge` returned the plain list when the lengths differed, so adding one
    carrier to a technology deleted the comments on the carriers already there.
    Adding an item to a list is the ordinary case for an editor.
    """

    LISTS = """\
techs:
  boiler:
    carrier_in:
      - power     # the main one
      - heat      # secondary
"""

    @pytest.fixture
    def lists(self, tmp_path: Path) -> Path:
        path = tmp_path / "lists.yaml"
        path.write_text(self.LISTS, encoding="utf-8")
        return path

    def test_appending_keeps_the_existing_comments(self, lists):
        data = _over_the_wire(lists, "techs")
        data["boiler"]["carrier_in"].append("gas")
        write_section(lists, "techs", data)

        text = lists.read_text(encoding="utf-8")
        assert "# the main one" in text
        assert "# secondary" in text
        assert "- gas" in text

    def test_truncating_keeps_the_comments_on_what_is_left(self, lists):
        data = _over_the_wire(lists, "techs")
        data["boiler"]["carrier_in"] = ["power"]
        write_section(lists, "techs", data)

        text = lists.read_text(encoding="utf-8")
        assert "# the main one" in text
        assert "heat" not in text


class TestEncoding:
    """Every read and write is UTF-8, explicitly.

    There was no `encoding=` anywhere in `src/`, so both halves used the locale
    codec while `deps.require_text` — the editor's own read — said UTF-8. On a
    Western Windows box a save wrote cp1252 bytes, the next open decoded them as
    replacement characters, and the save after that wrote the replacements.
    """

    def test_non_ascii_content_survives_a_no_op_save(self, tmp_path: Path):
        path = tmp_path / "accents.yaml"
        original = "techs:\n  boiler:\n    name: Wärmepumpe  # größer, 常用\n"
        path.write_text(original, encoding="utf-8")
        write_section(path, "techs", _over_the_wire(path, "techs"))
        assert path.read_text(encoding="utf-8") == original

    def test_a_non_utf8_file_is_reported_rather_than_raised(self, tmp_path: Path):
        """`load_quietly` promises None on *any* failure, and a decode failure is
        a `ValueError` rather than an `OSError`, so it escaped — and one stray
        Latin-1 byte anywhere in a workspace 500ed the component tree, the
        import graph, `/geo/`, snapshotting, resolution and validation at once.
        """
        from calliope_studio.modeldef.yaml_io import load_quietly, syntax_errors

        path = tmp_path / "latin1.yaml"
        path.write_bytes("name: caf\xe9\n".encode("latin-1"))

        assert load_quietly(path) is None
        problems = syntax_errors(path, "latin1.yaml")
        assert len(problems) == 1
        assert problems[0]["file"] == "latin1.yaml"
        assert "utf-8" in problems[0]["message"]


class TestAtomicWrites:
    """A model definition is never truncated in place.

    `runs.protocol` writes the run registry atomically because "a registry lost
    to a half-written file is every model the user has ever opened". The user's
    own `techs.yaml` was written with a plain `write_text`.
    """

    def test_a_save_leaves_no_temporary_file_behind(self, sample_file):
        write_section(sample_file, "techs", read_section(sample_file, "techs"))
        assert list(sample_file.parent.glob("*.tmp")) == []

    def test_a_failed_write_leaves_the_original_intact(self, sample_file):
        import os

        from calliope_studio.modeldef import paths as paths_module

        original = sample_file.read_text(encoding="utf-8")

        def explode(fd: int) -> None:
            os.close(fd)
            raise OSError("no space left on device")

        with pytest.raises(OSError):
            paths_module._replace_atomically(sample_file, explode)

        assert sample_file.read_text(encoding="utf-8") == original
        assert list(sample_file.parent.glob("*.tmp")) == []
