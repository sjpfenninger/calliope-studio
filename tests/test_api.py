"""The HTTP surface.

URL shapes are inherited from the prototype the frontend came from, so these
also serve as a contract test: if a path or payload here changes, the Vue app
breaks.
"""

import pytest


@pytest.fixture
def ws(client):
    """The workspace id the test client has open."""
    return client.workspace_id


class TestHealth:
    def test_reports_the_open_workspace(self, client, national_scale):
        body = client.get("/api/health").json()
        assert body["status"] == "ok"
        assert body["workspace"] == str(national_scale)
        assert body["workspace_id"]

    def test_unmatched_api_paths_do_not_fall_through_to_the_spa(self, client):
        """A withdrawn or mistyped endpoint must fail loudly, not return HTML."""
        response = client.get("/api/does-not-exist")
        assert response.status_code == 404
        assert "text/html" not in response.headers.get("content-type", "")


class TestProjects:
    def test_opened_folder_appears_as_a_project(self, client, ws):
        projects = client.get("/api/projects/").json()
        assert [p["id"] for p in projects] == [ws]

    def test_project_detail(self, client, ws, national_scale):
        body = client.get(f"/api/projects/{ws}/").json()
        assert body["name"] == national_scale.name

    def test_unknown_project_is_404(self, client):
        assert client.get("/api/projects/deadbeef/").status_code == 404

    def test_a_workspace_has_one_version_sharing_its_id(self, client, ws):
        versions = client.get(f"/api/projects/{ws}/versions/").json()
        assert [v["id"] for v in versions] == [ws]

    def test_opening_a_folder_registers_it(self, client, urban_scale):
        body = client.post("/api/projects/", json={"path": str(urban_scale)})
        assert body.status_code == 201
        assert body.json()["name"] == "urban_scale"
        assert len(client.get("/api/projects/").json()) == 2

    def test_opening_a_non_directory_is_rejected(self, client, national_scale):
        response = client.post(
            "/api/projects/", json={"path": str(national_scale / "model.yaml")}
        )
        assert response.status_code == 400


class TestFiles:
    def test_file_tree_lists_the_model(self, client, ws):
        entries = client.get(f"/api/versions/{ws}/files/").json()
        paths = {entry["path"] for entry in entries}
        assert "model.yaml" in paths
        assert any(path.endswith(".csv") for path in paths)
        assert {entry["type"] for entry in entries} <= {"yaml", "csv", "other"}

    def test_run_outputs_are_hidden_from_the_tree(self, client, ws, national_scale):
        (national_scale / ".calligraph" / "runs" / "x").mkdir(parents=True)
        (national_scale / ".calligraph" / "runs" / "x" / "run.log").write_text("noise")
        paths = {e["path"] for e in client.get(f"/api/versions/{ws}/files/").json()}
        assert not any(path.startswith(".calligraph") for path in paths)

    def test_read_and_write_round_trip(self, client, ws):
        url = f"/api/versions/{ws}/files/model.yaml"
        original = client.get(url).json()["content"]
        assert "config:" in original

        assert client.put(
            url, json={"content": original + "\n# appended\n"}
        ).json() == {"ok": True}
        assert client.get(url).json()["content"].endswith("# appended\n")

    def test_missing_file_is_404(self, client, ws):
        assert client.get(f"/api/versions/{ws}/files/nope.yaml").status_code == 404

    @pytest.mark.parametrize(
        "attack",
        [
            # Percent-encoded, because an HTTP client collapses a literal `..`
            # out of the URL before it is ever sent. This is the form that
            # actually reaches a handler.
            "%2e%2e%2fescape.yaml",
            "%2e%2e/escape.yaml",
            "..%2fescape.yaml",
            "%2e%2e%2f%2e%2e%2fetc%2fpasswd",
        ],
    )
    def test_path_traversal_is_rejected(self, client, ws, attack):
        response = client.get(f"/api/versions/{ws}/files/{attack}")
        assert response.status_code == 400
        assert response.json()["detail"] == "Invalid path."


class TestCsv:
    def test_read_infers_column_types(self, client, ws):
        body = client.get(f"/api/versions/{ws}/csv/data_tables/costs.csv").json()
        assert body["columns"]
        assert body["rows"]
        assert {column["type"] for column in body["columns"]} <= {"numeric", "text"}

    def test_write_round_trip(self, client, ws):
        url = f"/api/versions/{ws}/csv/data_tables/costs.csv"
        body = client.get(url).json()
        assert client.put(url, json=body).json() == {"ok": True}
        assert client.get(url).json() == body


class TestYamlSections:
    def test_read_a_section(self, client, ws):
        body = client.get(
            f"/api/versions/{ws}/yaml-section/model.yaml", params={"section": "config"}
        ).json()
        assert body["section"] == "config"
        assert "init" in body["data"]

    def test_missing_section_is_404(self, client, ws):
        response = client.get(
            f"/api/versions/{ws}/yaml-section/model.yaml", params={"section": "nope"}
        )
        assert response.status_code == 404

    def test_section_required(self, client, ws):
        response = client.get(f"/api/versions/{ws}/yaml-section/model.yaml")
        assert response.status_code == 422

    def test_write_preserves_comments_elsewhere(self, client, ws, national_scale):
        url = f"/api/versions/{ws}/yaml-section/model.yaml"
        before = (national_scale / "model.yaml").read_text()

        data = client.get(url, params={"section": "config"}).json()["data"]
        data["init"]["name"] = "Renamed by test"
        assert client.put(
            url, params={"section": "config"}, json={"data": data}
        ).json() == {"ok": True}

        after = (national_scale / "model.yaml").read_text()
        assert "Renamed by test" in after
        # A comment from a different section must be untouched.
        assert "# --8<-- [start:import]" in after
        assert len(before.splitlines()) == len(after.splitlines())


class TestStructure:
    def test_component_tree_names_the_defining_file(self, client, ws):
        tree = client.get(f"/api/versions/{ws}/component-tree/").json()
        assert "techs" in tree and "nodes" in tree
        entry = tree["techs"]["entries"][0]
        assert set(entry) >= {"name", "file"}

    def test_import_graph_is_rooted_at_model_yaml(self, client, ws):
        graph = client.get(f"/api/versions/{ws}/import-graph/").json()
        roots = [node for node in graph["nodes"] if node["type"] == "root"]
        assert [node["id"] for node in roots] == ["model.yaml"]
        assert graph["edges"]

    @pytest.mark.parametrize("kind", ["tech", "node"])
    def test_data_table_params(self, client, ws, kind):
        body = client.get(
            f"/api/versions/{ws}/data-table-params/", params={"kind": kind}
        ).json()
        assert body["kind"] == kind
        assert isinstance(body["params"], dict)

    def test_tech_params_come_from_the_costs_table(self, client, ws):
        params = client.get(
            f"/api/versions/{ws}/data-table-params/", params={"kind": "tech"}
        ).json()["params"]
        assert params, "expected the costs data table to yield tech parameters"
        entry = next(iter(params.values()))
        info = next(iter(entry.values()))
        assert set(info) >= {"value", "time_varying", "source"}

    def test_invalid_kind_is_rejected(self, client, ws):
        response = client.get(
            f"/api/versions/{ws}/data-table-params/", params={"kind": "bogus"}
        )
        assert response.status_code == 422


class TestSchema:
    def test_schema_is_generated_from_installed_calliope(self, client):
        import calliope

        body = client.get("/api/schema/calliope/").json()
        assert body["type"] == "object"
        assert body["x-calliope"]["version"] == calliope.__version__

    def test_parameter_registry_carries_units_and_titles(self, client):
        registry = client.get("/api/schema/calliope/").json()["x-calliope"]["registry"]
        assert len(registry["parameters"]) > 50
        assert registry["parameters"]["flow_cap_max"]["title"]


class TestValidation:
    def test_clean_model_has_no_syntax_errors(self, client, ws):
        assert client.post(f"/api/versions/{ws}/validate/").json() == {"errors": []}

    def test_broken_yaml_is_reported_with_a_line_number(
        self, client, ws, national_scale
    ):
        (national_scale / "broken.yaml").write_text("a: 1\n  b: [unclosed\n")
        errors = client.post(f"/api/versions/{ws}/validate/").json()["errors"]
        assert len(errors) == 1
        assert errors[0]["file"] == "broken.yaml"
        assert errors[0]["line"] is not None
        assert errors[0]["severity"] == "error"
