"""Geometry read from a model definition.

Both halves of the app render the same GeoJSON, so these also pin the shape
`calligraph.results.geo` has to keep producing.
"""

import pytest

from calligraph.modeldef import geo
from calligraph.modeldef.entities import merged_section


class TestNodes:
    def test_nodes_with_coordinates_become_points(self, national_scale):
        collection = geo.nodes_geojson(national_scale)
        assert collection["type"] == "FeatureCollection"
        assert {feature["id"] for feature in collection["features"]} == {
            "region1",
            "region2",
            "region1_1",
            "region1_2",
            "region1_3",
        }
        for feature in collection["features"]:
            longitude, latitude = feature["geometry"]["coordinates"]
            assert -180 <= longitude <= 180
            assert -90 <= latitude <= 90

    def test_nodes_without_coordinates_are_skipped(self, national_scale, tmp_path):
        locations = national_scale / "model_config" / "locations.yaml"
        locations.write_text(
            locations.read_text().replace(
                "    latitude: 40\n    longitude: -2\n", "", 1
            )
        )
        names = {f["id"] for f in geo.nodes_geojson(national_scale)["features"]}
        assert "region1" not in names

    def test_coordinates_can_come_from_a_data_table(self, tmp_path):
        """`latitude` is an ordinary parameter, so a CSV can supply it.

        `examples/model_nld-NUTS3-v1` defines all 37 of its nodes as `techs: {}`
        and gets 31 positions from `tabular-data/scalars/nodes.csv`. Reading only
        the `nodes:` section left that model's geography off the map entirely.
        """
        model = tmp_path / "tabular"
        (model / "data").mkdir(parents=True)
        (model / "model.yaml").write_text(
            "data_tables:\n"
            "  nodes:\n"
            '    data: "data/nodes.csv"\n'
            "    rows: nodes\n"
            "    columns: [parameters]\n"
            "nodes:\n"
            "  a:\n"
            "    techs: {}\n"
            "  b:\n"
            "    techs: {}\n"
        )
        (model / "data" / "nodes.csv").write_text(
            "nodes,latitude,longitude\na,50,4\nb,51,5\n"
        )

        positions = geo.node_positions(model)
        assert positions == {"a": [4.0, 50.0], "b": [5.0, 51.0]}

    def test_the_yaml_wins_over_a_data_table(self, tmp_path):
        """Which is what Calliope does, and what a drag depends on.

        Dragging a node writes a YAML coordinate; if the table won, the node
        would spring back to where the CSV puts it.
        """
        model = tmp_path / "both"
        (model / "data").mkdir(parents=True)
        (model / "model.yaml").write_text(
            "data_tables:\n"
            "  nodes:\n"
            '    data: "data/nodes.csv"\n'
            "    rows: nodes\n"
            "    columns: [parameters]\n"
            "nodes:\n"
            "  a:\n"
            "    latitude: 60\n"
        )
        (model / "data" / "nodes.csv").write_text("nodes,latitude,longitude\na,50,4\n")

        # Latitude from the file being edited, longitude from the table.
        assert geo.node_positions(model) == {"a": [4.0, 60.0]}

    def test_a_node_only_a_table_names_is_still_a_node(self, tmp_path):
        model = tmp_path / "csv-only"
        (model / "data").mkdir(parents=True)
        (model / "model.yaml").write_text(
            "data_tables:\n"
            "  nodes:\n"
            '    data: "data/nodes.csv"\n'
            "    rows: nodes\n"
            "    columns: [parameters]\n"
        )
        (model / "data" / "nodes.csv").write_text("nodes,latitude,longitude\nz,50,4\n")

        assert "z" in geo.node_positions(model)

    def test_a_relative_path_works(self, national_scale, monkeypatch):
        """Imports resolve to absolute paths and are checked against the base.

        A relative base fails that check for every import, which silently
        yields a model with no nodes at all rather than an error.
        """
        monkeypatch.chdir(national_scale.parent)
        assert geo.nodes_geojson(national_scale.name)["features"]


class TestLinks:
    def test_links_come_from_transmission_techs(self, national_scale):
        """Calliope 0.7 has no `links:` section.

        Transmission is defined under `techs:` with `link_from`/`link_to`;
        looking for a `links:` section finds nothing in any current model.
        """
        collection = geo.links_geojson(national_scale)
        assert collection["features"], "expected transmission techs to yield links"
        for feature in collection["features"]:
            assert feature["geometry"]["type"] == "LineString"
            assert len(feature["geometry"]["coordinates"]) == 2
            assert feature["properties"]["node_from"]
            assert feature["properties"]["node_to"]

    def test_colours_are_inherited_through_templates(self, national_scale):
        """Most transmission techs get their colour from a template.

        Without resolving `template:`, they would be drawn with no colour.
        """
        features = geo.links_geojson(national_scale)["features"]
        inherited = [
            feature
            for feature in features
            if feature["id"].startswith("region1_to_region1_")
        ]
        assert inherited
        assert all("color" in feature["properties"] for feature in inherited)

    def test_links_to_unmapped_nodes_are_skipped(self, national_scale):
        locations = national_scale / "model_config" / "locations.yaml"
        locations.write_text(
            locations.read_text().replace(
                "  region2:\n    latitude: 40\n    longitude: -8\n", "  region2:\n", 1
            )
        )
        names = {f["id"] for f in geo.links_geojson(national_scale)["features"]}
        assert "region1_to_region2" not in names

    def test_a_model_without_transmission_has_no_links(self, tmp_path):
        model = tmp_path / "flat"
        model.mkdir()
        (model / "model.yaml").write_text(
            "nodes:\n  a:\n    latitude: 1\n    longitude: 2\n"
        )
        assert geo.links_geojson(model)["features"] == []


class TestBounds:
    def test_bounds_enclose_every_node(self, national_scale):
        nodes = geo.nodes_geojson(national_scale)
        (west, south), (east, north) = geo.bounds(nodes)
        for feature in nodes["features"]:
            longitude, latitude = feature["geometry"]["coordinates"]
            assert west < longitude < east
            assert south < latitude < north

    def test_a_single_node_still_gets_a_box(self, tmp_path):
        model = tmp_path / "one"
        model.mkdir()
        (model / "model.yaml").write_text(
            "nodes:\n  only:\n    latitude: 10\n    longitude: 20\n"
        )
        (west, south), (east, north) = geo.bounds(geo.nodes_geojson(model))
        # Zero span would give a degenerate box the map cannot fit to.
        assert east > west and north > south

    def test_no_nodes_means_no_bounds(self, tmp_path):
        model = tmp_path / "empty"
        model.mkdir()
        (model / "model.yaml").write_text("config:\n  init:\n    name: x\n")
        assert geo.bounds(geo.nodes_geojson(model)) is None


class TestPayload:
    def test_shape_matches_the_results_endpoint(self, national_scale):
        payload = geo.geojson(national_scale)
        assert set(payload) == {"nodes", "links", "bounds", "colors"}

    def test_tech_colours_include_template_inheritance(self, national_scale):
        colors = geo.tech_colors(national_scale)
        assert colors
        assert all(value.startswith("#") for value in colors.values())
        assert "region1_to_region1_1" in colors


class TestApi:
    def test_geo_endpoint(self, client, national_scale):
        payload = client.get(f"/api/versions/{client.workspace_id}/geo/").json()
        assert payload["nodes"]["features"]
        assert payload["links"]["features"]
        assert payload["bounds"]

    def test_unknown_workspace_is_404(self, client):
        assert client.get("/api/versions/nope/geo/").status_code == 404


@pytest.mark.parametrize("section", ["nodes", "techs"])
def test_definitions_merge_across_imported_files(national_scale, section):
    """A model spreads nodes and techs over several files."""
    assert len(merged_section(national_scale, section)) > 1
