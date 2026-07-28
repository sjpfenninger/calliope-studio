"""The results HTTP surface, including the Arrow wire format."""

import io
import json

import pyarrow as pa
import pytest
from fastapi.testclient import TestClient

from calliope_studio.server.app import create_app

ARROW_STREAM = "application/vnd.apache.arrow.stream"


@pytest.fixture
def results_client(solved_results, storage):
    """A client opened directly on a solved model, as `calliope-studio results.nc`."""
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

    def test_reports_each_variables_dimensions(self, results_client):
        body = results_client.get(
            f"/api/results/{results_client.handle}/catalog/"
        ).json()
        dims = body["variables"]["dims"]
        assert "nodes" in dims["flow_cap"]
        assert "techs" in dims["flow_cap"]
        assert "timesteps" in dims["flow*"]

    def test_carries_colours_and_dimensions(self, results_client):
        body = results_client.get(
            f"/api/results/{results_client.handle}/catalog/"
        ).json()
        assert body["colors"]
        assert "techs" in body["dimensions"]
        assert body["time_extent"] and len(body["time_extent"]) == 2

    def test_carries_links_with_their_endpoints(self, results_client):
        body = results_client.get(
            f"/api/results/{results_client.handle}/catalog/"
        ).json()
        assert body["links"]
        assert "transmission_techs" not in body
        for link in body["links"]:
            assert set(link) == {"tech", "from", "to"}
            # The sidebar splits `dimensions.techs` into two sections, so every
            # link must still be in it or one of them silently loses members.
            assert link["tech"] in body["dimensions"]["techs"]
            assert link["from"] and link["to"]

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

    def test_unknown_selector_members_do_not_blame_the_variable(self, results_client):
        """A stale selection must not report the variable as missing."""
        response = results_client.post(
            f"/api/results/{results_client.handle}/frame/",
            json={"variable": "flow*", "selectors": {"techs": ["no_such_tech"]}},
        )
        assert response.status_code == 200
        assert response.headers["content-type"] == ARROW_STREAM

    def test_partially_stale_selection_keeps_what_exists(self, results_client):
        response = results_client.post(
            f"/api/results/{results_client.handle}/frame/",
            json={
                "variable": "flow*",
                "sum_by": "nodes",
                "selectors": {"techs": ["ccgt", "no_such_tech"]},
            },
        )
        assert response.status_code == 200
        assert read_arrow(response).num_columns > 1

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


class TestSource:
    """Which run a set of results came from.

    The relationship was one-way and lossy: given a handle you could not recover
    the run, the workspace or any metadata, and `catalog` reports a `name` taken
    from the file stem — so every run's results were called "results".
    """

    def test_a_bare_results_file_reports_itself(self, results_client):
        handle = results_client.get("/api/health").json()["results_handle"]
        source = results_client.get(f"/api/results/{handle}/source/").json()

        assert source["kind"] == "file"
        assert source["run_id"] is None
        assert source["workspace_id"] is None
        assert source["path"].endswith(".nc")

    def test_a_runs_results_report_the_run_and_workspace(self, client):
        import time

        ws = client.workspace_id
        run_id = client.post(
            f"/api/versions/{ws}/runs/", json={"label": "baseline"}
        ).json()["id"]
        deadline = time.time() + 300
        record = None
        while time.time() < deadline:
            record = client.get(f"/api/runs/{run_id}/").json()
            if record["status"] != "running":
                break
            time.sleep(0.5)
        assert record["status"] == "success", record.get("error")

        source = client.get(f"/api/results/{record['results_handle']}/source/").json()

        assert source["kind"] == "run"
        assert source["run_id"] == run_id
        assert source["workspace_id"] == ws
        # What the frontend titles the tab with, instead of the string "results".
        assert source["label"] == "baseline"
        assert source["created_at"]

    def test_an_unknown_handle_is_404(self, results_client):
        assert results_client.get("/api/results/deadbeef/source/").status_code == 404


class TestBrowse:
    """The folder browser behind the Open-model dialog."""

    def test_it_lists_directories_and_marks_models(self, client, national_scale):
        body = client.get(
            "/api/browse/", params={"path": str(national_scale.parent)}
        ).json()

        assert body["path"] == str(national_scale.parent.resolve())
        entry = next(e for e in body["entries"] if e["name"] == national_scale.name)
        assert entry["is_model"] is True

    def test_a_folder_without_a_model_is_marked_as_such(self, client, tmp_path):
        (tmp_path / "empty").mkdir()
        body = client.get("/api/browse/", params={"path": str(tmp_path)}).json()
        entry = next(e for e in body["entries"] if e["name"] == "empty")
        assert entry["is_model"] is False

    def test_it_never_returns_files(self, client, national_scale):
        """Directory entries only — reading goes through the guarded routes."""
        body = client.get("/api/browse/", params={"path": str(national_scale)}).json()
        assert all("model.yaml" != entry["name"] for entry in body["entries"])
        assert "content" not in body

    def test_a_folder_called_calliope_studio_is_still_reachable(self, client, tmp_path):
        """`EXCLUDED_NAMES` is about model definitions, not about the whole disk.

        Applied to every listing it made any folder on the machine sharing the
        output directory's name unreachable — including the one this project is
        developed in, which is how it was found.
        """
        (tmp_path / "calliope-studio").mkdir()
        body = client.get("/api/browse/", params={"path": str(tmp_path)}).json()
        assert "calliope-studio" in [entry["name"] for entry in body["entries"]]

    def test_a_models_own_output_directory_is_hidden(self, client, national_scale):
        """Inside a model folder, `calliope-studio/` is this app's own output.

        There it is noise rather than a place anyone would open, so the rule
        applies where it actually means something.
        """
        (national_scale / "calliope-studio").mkdir(exist_ok=True)
        body = client.get("/api/browse/", params={"path": str(national_scale)}).json()
        assert all(entry["name"] != "calliope-studio" for entry in body["entries"])

    def test_the_root_has_no_parent(self, client):
        body = client.get("/api/browse/", params={"path": "/"}).json()
        assert body["parent"] is None

    def test_it_defaults_to_the_home_directory(self, client):
        from pathlib import Path

        assert client.get("/api/browse/").json()["path"] == str(Path.home().resolve())

    def test_a_missing_directory_is_404(self, client, tmp_path):
        response = client.get("/api/browse/", params={"path": str(tmp_path / "nope")})
        assert response.status_code == 404


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

    def test_run_history_is_newest_first(self, client):
        """The frontend takes the first run with results as "the latest".

        Run directories are named with UUIDs, so ordering by name is arbitrary
        while looking deliberate.
        """
        import time

        first = client.post(f"/api/versions/{client.workspace_id}/runs/").json()["id"]
        time.sleep(1.1)  # filesystem timestamps are not always sub-second
        second = client.post(f"/api/versions/{client.workspace_id}/runs/").json()["id"]

        history = client.get(f"/api/versions/{client.workspace_id}/runs/").json()
        order = [record["id"] for record in history]
        assert order.index(second) < order.index(first)
