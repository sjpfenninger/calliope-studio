"""Comment-preserving YAML round-trip.

The editor's whole premise is that editing one section through a form leaves the
rest of the file exactly as the user wrote it. These are the tests that hold
that promise, so they are deliberately strict: byte comparison, not semantic.
"""

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
