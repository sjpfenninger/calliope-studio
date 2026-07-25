"""Building and solving models.

These tests really do solve, in a subprocess, with CBC. They are the slowest in
the suite and the most valuable: writing `results.nc` is the only thing
connecting the editor to the analysis half, and it is precisely what the
prototype this code came from failed to do.
"""

import json
import time

import pytest

TERMINAL = {"success", "infeasible", "failed", "cancelled"}


def wait_for_terminal(client, run_id, timeout=300):
    """Polls a run until it finishes, returning its final record."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        record = client.get(f"/api/runs/{run_id}/").json()
        if record["status"] in TERMINAL:
            return record
        time.sleep(0.5)
    pytest.fail(f"run {run_id} did not finish within {timeout}s")


def wait_for_task(client, task_id, timeout=300):
    deadline = time.time() + timeout
    while time.time() < deadline:
        body = client.get(f"/api/tasks/{task_id}/").json()
        if body["status"] == "done":
            return body["result"]
        time.sleep(0.5)
    pytest.fail(f"task {task_id} did not finish within {timeout}s")


@pytest.fixture
def ws(client):
    return client.workspace_id


class TestRunLifecycle:
    def test_run_solves_and_writes_results(self, client, ws, national_scale):
        created = client.post(f"/api/versions/{ws}/runs/")
        assert created.status_code == 201
        run_id = created.json()["id"]

        record = wait_for_terminal(client, run_id)
        assert record["status"] == "success", record.get("error")
        assert record["termination_condition"] == "optimal"
        assert record["has_results"] is True
        # Timestamps must be in a sensible order, which they are not if
        # `created_at` is taken from a directory whose mtime keeps moving.
        assert record["created_at"] <= record["completed_at"]

        results = national_scale / ".calligraph" / "runs" / run_id / "results.nc"
        assert results.is_file()

        # The file has to be readable by the analysis half, which is the whole
        # point of writing it.
        import calliope

        model = calliope.read_netcdf(str(results))
        assert model.results
        assert "flow_cap" in model.results

    def test_run_history_survives_a_new_manager(self, client, ws):
        run_id = client.post(f"/api/versions/{ws}/runs/").json()["id"]
        wait_for_terminal(client, run_id)

        # Runs are rediscovered from disk, not held in memory, so a restarted
        # server still knows about them.
        client.app.state.runs.__init__()
        history = client.get(f"/api/versions/{ws}/runs/").json()
        assert run_id in {record["id"] for record in history}

    def test_events_stream_reports_stages_and_completion(self, client, ws):
        run_id = client.post(f"/api/versions/{ws}/runs/").json()["id"]

        stages, done = [], None
        with client.stream("GET", f"/api/runs/{run_id}/logs/") as response:
            assert response.status_code == 200
            assert response.headers["content-type"].startswith("text/event-stream")
            event = None
            for line in response.iter_lines():
                if line.startswith("event: "):
                    event = line.removeprefix("event: ").strip()
                elif line.startswith("data: ") and event:
                    payload = line.removeprefix("data: ").strip()
                    if event == "stage":
                        stages.append(json.loads(payload)["name"])
                    elif event == "done":
                        done = json.loads(payload)
                        break
                    event = None

        assert done is not None, "stream ended without a done event"
        assert done["status"] == "success"
        # Every stage the worker announces, in order.
        assert [s for i, s in enumerate(stages) if i == 0 or stages[i - 1] != s] == [
            "read",
            "build",
            "solve",
            "save",
        ]

    def test_stream_replays_history_for_a_late_subscriber(self, client, ws):
        """Connecting after a run finished still yields its whole log."""
        run_id = client.post(f"/api/versions/{ws}/runs/").json()["id"]
        wait_for_terminal(client, run_id)

        lines = []
        with client.stream("GET", f"/api/runs/{run_id}/logs/") as response:
            for line in response.iter_lines():
                lines.append(line)
        assert any("event: done" in line for line in lines)
        assert any(line.startswith("data: ") for line in lines)

    def test_unknown_run_is_404(self, client):
        assert client.get("/api/runs/nope/").status_code == 404
        assert client.get("/api/runs/nope/logs/").status_code == 404


class TestCancellation:
    def test_cancelling_stops_the_run(self, client, ws):
        run_id = client.post(f"/api/versions/{ws}/runs/").json()["id"]

        response = client.post(f"/api/runs/{run_id}/cancel/")
        assert response.status_code == 200
        assert response.json()["status"] == "cancelled"

        # Calliope has no interrupt API, so cancelling means the process group
        # is killed; verify it really is gone rather than merely marked.
        process = client.app.state.runs._processes[run_id]
        deadline = time.time() + 15
        while time.time() < deadline and process.poll() is None:
            time.sleep(0.25)
        assert process.poll() is not None, "worker process survived cancellation"
        assert client.get(f"/api/runs/{run_id}/").json()["status"] == "cancelled"


class TestDeepValidation:
    def test_valid_model_reports_no_errors(self, client, ws):
        task_id = client.post(f"/api/versions/{ws}/validate/deep/").json()["task_id"]
        assert wait_for_task(client, task_id) == {"errors": []}

    def test_deep_validation_is_accepted_asynchronously(self, client, ws):
        response = client.post(f"/api/versions/{ws}/validate/deep/")
        assert response.status_code == 202
        assert response.json()["task_id"]

    def test_semantically_broken_model_reports_errors(self, client, ws, national_scale):
        # Syntactically fine, but not a technology Calliope will accept.
        techs = national_scale / "model_config" / "techs.yaml"
        techs.write_text(
            techs.read_text().replace("base_tech: supply", "base_tech: nonsense", 1)
        )

        task_id = client.post(f"/api/versions/{ws}/validate/deep/").json()["task_id"]
        result = wait_for_task(client, task_id)
        assert result["errors"], "expected an invalid base_tech to be reported"
        assert result["errors"][0]["severity"] == "error"

    def test_unknown_task_is_404(self, client):
        assert client.get("/api/tasks/nope/").status_code == 404
