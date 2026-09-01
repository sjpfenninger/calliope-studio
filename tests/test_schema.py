"""What the served schema says a valid model looks like.

Calliope answers this itself — the payload is generated from its pydantic models
— but it answers in *validation* mode, and its shorthands (`dims: costs`,
`index: monetary`, `techs: {demand_power:}`) are implemented as `mode="before"`
field validators, which pydantic does not describe. So the published schema
rejects Calliope's own example models, and the editor drew squiggles on valid
syntax: 13 of them across five files of the two bundled models.

The assertion that matters is therefore not a shape test but this one — every
file Calliope ships validates clean against what we serve — since only that
notices the next time a coercion is added upstream. The negative controls are
the other half: a widening that quietly became "anything goes" would pass the
first test and fail these.
"""

import inspect
from pathlib import Path

import jsonschema
import pytest
from ruamel.yaml import YAML

from calliope_studio.modeldef.schema import calliope_schemas

#: Real Calliope syntax that the model-definition schema does not describe,
#: because file assembly resolves and removes it before anything is validated.
#: The frontend grafts loose descriptions in (`lib/calliopeSchema.ts`); here
#: they are simply dropped, since they are not what this file is about.
ASSEMBLY_KEYS = ("import", "overrides", "scenarios", "templates")


def _example_models_dir() -> Path:
    import calliope

    return Path(inspect.getfile(calliope)).parent / "example_models"


def _load(path: Path) -> dict:
    """Reads a file the way the browser's YAML parser does.

    YAML 1.2, so `zero_threshold: 1e-10` is a number. PyYAML is 1.1 and calls it
    a string, which would report a type error that nobody editing the file can
    see — monaco-yaml's parser and Calliope's own loader both agree it is a
    float.
    """
    return YAML(typ="safe").load(path.read_text(encoding="utf-8"))


def _model_files() -> list[Path]:
    root = _example_models_dir()
    return sorted(
        path
        for path in root.glob("**/*.yaml")
        # Named by `config.init.math_paths` and nothing else, so it is a math
        # file and is checked against the math schema below.
        if path.name != "additional_math.yaml"
    )


@pytest.fixture(scope="module")
def model_schema() -> dict:
    return calliope_schemas()


@pytest.fixture(scope="module")
def validator(model_schema) -> jsonschema.Draft202012Validator:
    """The schema as the editor assembles it, config block and all.

    `config:` is validated by a separate pydantic model, so it is not and never
    will be a property of the model-definition schema; the frontend grafts it in
    from `x-calliope.schemas` (`lib/calliopeSchema.ts::withSiblingSchemas`) and
    this mirrors that, because a model file that fails on its own `config:` is a
    file the user sees marked as broken.
    """
    siblings = model_schema["x-calliope"]["schemas"]
    properties = {**model_schema["properties"], "config": siblings["config"]}
    return jsonschema.Draft202012Validator({**model_schema, "properties": properties})


def _errors(validator, document: dict) -> list[str]:
    stripped = {k: v for k, v in document.items() if k not in ASSEMBLY_KEYS}
    return [
        f"{list(error.path)}: {error.message}"
        for error in validator.iter_errors(stripped)
    ]


class TestExampleModels:
    """Calliope's own models are the standard the schema is held to."""

    @pytest.mark.parametrize(
        "path", _model_files(), ids=lambda p: str(p.relative_to(_example_models_dir()))
    )
    def test_every_file_validates_clean(self, validator, path):
        """A model Calliope ships must not be marked as broken.

        This is what the 0.7.0 upgrade got past: the release renamed
        `parameters:` to `data_definitions:` and put two indexed entries in the
        entry file, so the first thing the editor opens carried the shorthand.
        """
        assert _errors(validator, _load(path)) == []

    def test_math_validates_against_the_math_schema(self, model_schema):
        """`urban_scale` is the one bundled model with user-defined math."""
        math_schema = model_schema["x-calliope"]["schemas"]["math"]
        path = _example_models_dir() / "urban_scale" / "additional_math.yaml"

        errors = list(
            jsonschema.Draft202012Validator(math_schema).iter_errors(_load(path))
        )
        assert errors == []


class TestShorthands:
    """The three coercions Calliope performs before validating."""

    def test_a_scalar_dim_is_a_list_of_one(self, validator):
        document = {
            "data_definitions": {
                "bigM": {"data": 1, "index": "monetary", "dims": "costs"}
            }
        }
        assert _errors(validator, document) == []

    def test_a_flat_index_is_a_list_of_lists(self, validator):
        document = {
            "data_definitions": {
                "cost_interest_rate": {
                    "data": [0.1, 0.2],
                    "index": ["monetary", "co2"],
                    "dims": "costs",
                }
            }
        }
        assert _errors(validator, document) == []

    def test_an_empty_technology_is_an_empty_mapping(self, validator):
        """`techs: {demand_power:}` is how every example model names a tech."""
        assert _errors(validator, {"techs": {"demand_power": None}}) == []
        assert (
            _errors(validator, {"nodes": {"a": {"techs": {"demand_power": None}}}})
            == []
        )

    def test_an_empty_techs_block_is_one_too(self, validator):
        """`urban_scale`'s node `N1` declares `techs:` with no body."""
        assert _errors(validator, {"techs": None}) == []
        assert _errors(validator, {"nodes": {"N1": {"techs": None}}}) == []


class TestStillRejected:
    """The widening is additive, and must not have become permissiveness."""

    def test_a_techs_block_that_is_not_a_mapping(self, validator):
        assert _errors(validator, {"techs": "not-a-mapping"}) != []

    def test_a_coordinate_that_is_not_a_number(self, validator):
        assert _errors(validator, {"nodes": {"a": {"latitude": "north"}}}) != []

    def test_an_unknown_top_level_key(self, validator):
        assert _errors(validator, {"locations": {}}) != []

    def test_an_indexed_entry_with_no_data(self, validator):
        assert (
            _errors(validator, {"data_definitions": {"bigM": {"index": "monetary"}}})
            != []
        )
