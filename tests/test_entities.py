"""Classifying a model's technologies.

Calliope 0.7 has no `links:` section: transmission is an ordinary entry under
`techs:` with `link_from`/`link_to`. The editor shows the two kinds separately,
so getting this wrong either hides links or mixes them in with everything else.
"""

import pytest

from calliope_studio.modeldef import entities
from calliope_studio.modeldef.imports import component_tree


class TestTransmissionDetection:
    def test_explicit_base_tech(self):
        assert entities.is_transmission({"base_tech": "transmission"})

    def test_endpoints_alone_are_enough(self):
        """A link whose base_tech comes from an unreadable template.

        Its endpoints still identify it unambiguously.
        """
        assert entities.is_transmission({"link_from": "a", "link_to": "b"})

    def test_one_endpoint_is_not_a_link(self):
        assert not entities.is_transmission({"link_from": "a"})

    @pytest.mark.parametrize(
        "entry", [{"base_tech": "supply"}, {}, None, "not a mapping"]
    )
    def test_everything_else_is_not(self, entry):
        assert not entities.is_transmission(entry)


class TestResolution:
    def test_templates_are_applied(self, national_scale):
        techs = entities.resolved_techs(national_scale)
        inherited = techs["region1_to_region1_1"]
        # base_tech lives on the free_transmission template, not the entry.
        assert inherited["base_tech"] == "transmission"
        assert inherited["link_from"] == "region1"

    def test_entry_overrides_its_template(self, national_scale, tmp_path):
        techs = national_scale / "model_config" / "techs.yaml"
        techs.write_text(
            techs.read_text().replace(
                "  region1_to_region1_1:\n    link_from: region1",
                "  region1_to_region1_1:\n    color: '#000000'\n    link_from: region1",
                1,
            )
        )
        resolved = entities.resolved_techs(national_scale)
        assert resolved["region1_to_region1_1"]["color"] == "#000000"

    def test_all_transmission_techs_are_found(self, national_scale):
        assert entities.transmission_techs(national_scale) == {
            "region1_to_region2",
            "region1_to_region1_1",
            "region1_to_region1_2",
            "region1_to_region1_3",
        }

    def test_sections_merge_across_files(self, national_scale):
        assert len(entities.merged_section(national_scale, "techs")) > 4


class TestComponentTree:
    def test_links_are_separated_from_techs(self, national_scale):
        tree = component_tree(national_scale)
        techs = {entry["name"] for entry in tree["techs"]["entries"]}
        links = {entry["name"] for entry in tree["links"]["entries"]}

        assert links == entities.transmission_techs(national_scale)
        assert not techs & links, "a technology must appear in exactly one group"
        assert "ccgt" in techs

    def test_links_carry_their_endpoints(self, national_scale):
        tree = component_tree(national_scale)
        by_name = {entry["name"]: entry for entry in tree["links"]["entries"]}
        assert by_name["region1_to_region2"]["link_from"] == "region1"
        assert by_name["region1_to_region2"]["link_to"] == "region2"

    def test_links_point_at_the_file_that_defines_them(self, national_scale):
        tree = component_tree(national_scale)
        for entry in tree["links"]["entries"]:
            assert entry["file"].endswith("techs.yaml")

    def test_a_file_of_only_links_shows_no_techs_group(self, tmp_path):
        model = tmp_path / "links_only"
        model.mkdir()
        (model / "model.yaml").write_text(
            "techs:\n"
            "  a_to_b:\n"
            "    base_tech: transmission\n"
            "    link_from: a\n"
            "    link_to: b\n"
        )
        tree = component_tree(model)
        assert "links" in tree
        assert "techs" not in tree, "an empty techs group should not be shown"

    def test_a_model_without_transmission_has_no_links_group(self, tmp_path):
        model = tmp_path / "flat"
        model.mkdir()
        (model / "model.yaml").write_text("techs:\n  solar:\n    base_tech: supply\n")
        tree = component_tree(model)
        assert "techs" in tree
        assert "links" not in tree
