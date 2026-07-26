"""The results HTTP surface, including the Arrow wire format."""

import io
import json

import pyarrow as pa
import pytest
from fastapi.testclient import TestClient

from calligraph.server.app import create_app

ARROW_STREAM = "application/vnd.apache.arrow.stream"


@pytest.fixture
def results_client(solved_results, storage):
    """A client opened directly on a solved model, as `calligraph results.nc`."""
    app = create_app(workspace=solved_results, storage=storage)
    with TestClient(app) as client:
        client.handle = app.state.active_results
        yield client


def read_arrow(response) -> pa.Table:
    return pa.ipc.open_stream(io.BytesIO(response.content)).read_all()


class TestOpeningAResultsFile:
    def test_health_reports_a_results_handle(self, results_client):
        body = results_client.get("/api/health").json()
        assert body["results_handle"] == results_client.handle
        # No model definition to edit, so no workspace.
        assert body["workspace_id"] is None

    def test_unknown_handle_is_404(self, results_client):
        assert results_client.get("/api/results/nope/catalog/").status_code == 404


class TestCatalog:
    def test_lists_variables_by_category(self, results_client):
        body = results_client.get(
            f"/api/results/{results_client.handle}/catalog/"
        ).json()
        variables = body["variables"]
        assert "flow*" in variables["timeseries"]
        assert "flow_cap" in variables["static"]
        assert variables["static_links"]

    def test_carries_colours_and_dimensions(self, results_client):
        body = results_client.get(
            f"/api/results/{results_client.handle}/catalog/"
        ).json()
        assert body["colors"]
        assert "techs" in body["dimensions"]
        assert body["time_extent"] and len(body["time_extent"]) == 2

    def test_names_synthetic_variables(self, results_client):
        body = results_client.get(
            f"/api/results/{results_client.handle}/catalog/"
        ).json()
        assert body["synthetic"]["flow*"]


class TestFrame:
    def test_returns_an_arrow_stream(self, results_client):
        response = results_client.post(
            f"/api/results/{results_client.handle}/frame/",
            json={"variable": "flow*", "resample": "1D", "sum_by": "nodes"},
        )
        assert response.status_code == 200
        assert response.headers["content-type"] == ARROW_STREAM

        table = read_arrow(response)
        assert table.num_rows > 0
        assert table.schema.names[0] == "timesteps"

    def test_series_metadata_survives_the_wire(self, results_client):
        response = results_client.post(
            f"/api/results/{results_client.handle}/frame/",
            json={"variable": "flow*", "resample": "1D", "sum_by": "nodes"},
        )
        field = read_arrow(response).schema.field(1)
        assert json.loads(field.metadata[b"dims"])
        assert field.metadata[b"color"].decode().startswith("#")

    def test_selectors_narrow_the_result(self, results_client):
        url = f"/api/results/{results_client.handle}/frame/"
        everything = read_arrow(
            results_client.post(url, json={"variable": "flow*", "sum_by": "nodes"})
        )
        narrowed = read_arrow(
            results_client.post(
                url,
                json={
                    "variable": "flow*",
                    "sum_by": "nodes",
                    "selectors": {"techs": ["ccgt"]},
                },
            )
        )
        assert narrowed.num_columns < everything.num_columns

    def test_null_selectors_are_ignored(self, results_client):
        response = results_client.post(
            f"/api/results/{results_client.handle}/frame/",
            json={"variable": "flow*", "selectors": {"techs": None}},
        )
        assert response.status_code == 200

    def test_duration_order_changes_the_index(self, results_client):
        table = read_arrow(
            results_client.post(
                f"/api/results/{results_client.handle}/frame/",
                json={"variable": "flow*", "sum_by": "nodes", "order": "duration"},
            )
        )
        assert table.schema.names[0] == "period"

    def test_unknown_variable_is_404(self, results_client):
        response = results_client.post(
            f"/api/results/{results_client.handle}/frame/",
            json={"variable": "no_such_variable"},
        )
        assert response.status_code == 404

    def test_invalid_order_is_rejected(self, results_client):
        response = results_client.post(
            f"/api/results/{results_client.handle}/frame/",
            json={"variable": "flow*", "order": "sideways"},
        )
        assert response.status_code == 422


class TestGeoAndSummary:
    def test_geo_returns_geojson(self, results_client):
        body = results_client.get(f"/api/results/{results_client.handle}/geo/").json()
        assert body["nodes"]["type"] == "FeatureCollection"
        assert body["links"]["features"]
        assert body["bounds"]

    def test_summary_is_json_serialisable(self, results_client):
        body = results_client.get(
            f"/api/results/{results_client.handle}/summary/"
        ).json()
        assert body["model"]["termination_condition"] == "optimal"
        assert body["solve_config"]["solver"]


class TestRunsExposeResults:
    """A finished run must lead straight to its charts."""

    def test_finished_run_carries_a_usable_handle(self, client):
        import time

        run_id = client.post(f"/api/versions/{client.workspace_id}/runs/").json()["id"]
        deadline = time.time() + 300
        record = None
        while time.time() < deadline:
            record = client.get(f"/api/runs/{run_id}/").json()
            if record["status"] in {"success", "infeasible", "failed", "cancelled"}:
                break
            time.sleep(0.5)

        assert record["status"] == "success", record.get("error")
        handle = record["results_handle"]
        assert handle

        catalog = client.get(f"/api/results/{handle}/catalog/")
        assert catalog.status_code == 200
        assert "flow*" in catalog.json()["variables"]["timeseries"]

    def test_unfinished_run_has_no_handle(self, client):
        created = client.post(f"/api/versions/{client.workspace_id}/runs/").json()
        assert created.get("results_handle") is None
