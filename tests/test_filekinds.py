"""Which Calliope schema describes which file.

The editor used to validate every `.yaml` in a workspace against the
model-definition schema, because a single `fileMatch` cannot say anything else.
A math file is not a model definition, so every key in it read as unknown.
"""

import pytest

from calliope_studio.modeldef.filekinds import MATH, MODEL, UNKNOWN, classify


@pytest.fixture
def ws(client):
    return client.workspace_id


class TestClassify:
    def test_an_import_chain_is_the_model_definition(self, national_scale):
        kinds = classify(national_scale)

        assert kinds["model.yaml"] == MODEL
        # Reached through `import:` from the entry point, two directories deep.
        assert kinds["model_config/techs.yaml"] == MODEL
        assert kinds["model_config/locations.yaml"] == MODEL

    def test_math_paths_are_found_where_the_import_graph_cannot_look(self, urban_scale):
        """`urban_scale` names its math in `config.init.math_paths` and nowhere else.

        Nothing imports `additional_math.yaml`, so the import graph does not
        reach it; before this it was validated against the model-definition
        schema, where none of its keys exist.
        """
        kinds = classify(urban_scale)

        assert kinds["additional_math.yaml"] == MATH
        assert kinds["model.yaml"] == MODEL

    def test_an_unreferenced_file_is_unknown(self, national_scale):
        """The normal state of a file being drafted, and not an error.

        It gets no schema rather than the wrong one — which is what the user can
        override when they know better than we do.
        """
        (national_scale / "scratch.yaml").write_text("techs:\n  a:\n    x: 1\n")

        assert classify(national_scale)["scratch.yaml"] == UNKNOWN

    def test_every_yaml_file_is_accounted_for(self, national_scale):
        """ "Not referred to" has to be distinguishable from "never heard of"."""
        (national_scale / "scratch.yaml").write_text("a: 1\n")
        kinds = classify(national_scale)

        on_disk = {
            path.relative_to(national_scale).as_posix()
            for path in national_scale.rglob("*.yaml")
        }
        assert on_disk <= set(kinds)

    def test_a_model_that_does_not_parse_still_classifies(self, national_scale):
        """The editor's normal state. A half-written file must not lose the rest."""
        (national_scale / "broken.yaml").write_text("a: 1\n  b: [unclosed\n")

        kinds = classify(national_scale)

        assert kinds["model.yaml"] == MODEL
        assert kinds["broken.yaml"] == UNKNOWN


class TestFileKindsEndpoint:
    def test_it_reports_the_workspace(self, client, ws):
        body = client.get(f"/api/versions/{ws}/schema/files/").json()

        assert body["kinds"]["model.yaml"] == MODEL
