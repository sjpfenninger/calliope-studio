"""Building and solving models.

These tests really do solve, in a subprocess, with CBC. They are the slowest in
the suite and the most valuable: writing `results.nc` is the only thing
connecting the editor to the analysis half, and it is precisely what the
prototype this code came from failed to do.
"""

import json
import shutil
import time

import pytest

from calligraph.runs.manager import RunManager

TERMINAL = {"success", "infeasible", "failed", "cancelled"}


def restart(client):
    """Replaces the run manager, as restarting the server would.

    Wired the way `create_app` wires it, so the replacement can still *find* runs
    it did not start. Constructing a bare `RunManager()` here would only prove
    that `discover` repopulates its cache, which was never the bug.
    """
    app = client.app
    app.state.runs = RunManager(search_roots=lambda: app.state.storage.run_roots())
    return app.state.runs


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


class TestWorkspaceIsUntouchedUntilYouRun:
    """Opening a model, and looking at it, must leave the folder alone."""

    def test_listing_runs_creates_nothing(self, client, ws, national_scale):
        """The interface lists runs on load; that must not create a directory.

        `runs_dir()` used to create the directory as a side effect of being asked
        for it, so a folder gained a `calligraph/` before the user had done
        anything at all.
        """
        before = sorted(path.name for path in national_scale.iterdir())

        assert client.get(f"/api/versions/{ws}/runs/").json() == []

        assert sorted(path.name for path in national_scale.iterdir()) == before
        assert not (national_scale / "calligraph").exists()

    def test_running_creates_the_directory_with_a_gitignore(
        self, client, ws, national_scale
    ):
        run_id = client.post(f"/api/versions/{ws}/runs/").json()["id"]
        wait_for_terminal(client, run_id)

        data_dir = national_scale / "calligraph"
        assert (data_dir / "runs" / run_id).is_dir()
        assert (data_dir / ".gitignore").is_file()

    def test_deep_validation_leaves_nothing_behind(self, client, ws, national_scale):
        """A validation has no artefact worth keeping.

        Each click used to leave a permanent UUID-named directory beside the
        model, unreachable and unremovable from the interface.
        """
        before = sorted(path.name for path in national_scale.iterdir())

        task_id = client.post(f"/api/versions/{ws}/validate/deep/").json()["task_id"]
        wait_for_task(client, task_id)

        assert sorted(path.name for path in national_scale.iterdir()) == before
        assert not (national_scale / "calligraph").exists()
        assert not (national_scale / ".calligraph").exists()


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

        results = national_scale / "calligraph" / "runs" / run_id / "results.nc"
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
        restart(client)
        history = client.get(f"/api/versions/{ws}/runs/").json()
        assert run_id in {record["id"] for record in history}

    def test_run_endpoints_work_after_a_restart_without_listing_first(self, client, ws):
        """A bookmarked run URL keeps working across a server restart.

        The manager used to hold the id-to-directory mapping only in memory, so
        every one of these returned 404 until something happened to list the
        workspace's runs and repopulate it. Listing first is exactly what a
        client following a bookmark does not do.
        """
        run_id = client.post(f"/api/versions/{ws}/runs/").json()["id"]
        wait_for_terminal(client, run_id)

        restart(client)

        assert client.get(f"/api/runs/{run_id}/").status_code == 200
        assert client.get(f"/api/runs/{run_id}/logs/").status_code == 200

    def test_run_records_timings_solver_and_objective(self, client, ws):
        """Diagnostics a user comparing two runs looks at first.

        `timings` was written through a `.root` attribute that Calliope's schema
        does not have, so it raised on every run and `outcome.json` never
        contained it.
        """
        run_id = client.post(f"/api/versions/{ws}/runs/").json()["id"]
        record = wait_for_terminal(client, run_id)
        assert record["status"] == "success", record.get("error")

        assert record["timings"], "no timings recorded"
        assert all(isinstance(value, float) for value in record["timings"].values())
        assert record["solver"]
        assert isinstance(record["objective"], float)
        assert record["duration_seconds"] > 0

    def test_created_at_survives_a_touched_request_file(
        self, client, ws, national_scale
    ):
        """History order comes from the recorded timestamp, not the file's mtime.

        An mtime is lost when a workspace is copied or restored from a backup,
        which silently reshuffles the whole run history.
        """
        run_id = client.post(f"/api/versions/{ws}/runs/").json()["id"]
        created_at = wait_for_terminal(client, run_id)["created_at"]

        request_file = national_scale / "calligraph" / "runs" / run_id / "request.json"
        import os

        os.utime(request_file, (0, 0))

        assert client.get(f"/api/runs/{run_id}/").json()["created_at"] == created_at

    def test_unknown_fields_in_request_do_not_hide_the_run(
        self, client, ws, national_scale
    ):
        """A run written by a future version still appears in the history.

        `RunRequest.read` used to splat the whole file into the constructor, so
        one added or renamed field would raise during discovery and take the
        user's entire history with it.
        """
        run_id = client.post(f"/api/versions/{ws}/runs/").json()["id"]
        wait_for_terminal(client, run_id)

        request_file = national_scale / "calligraph" / "runs" / run_id / "request.json"
        payload = json.loads(request_file.read_text())
        payload["a_field_from_the_future"] = {"nested": True}
        request_file.write_text(json.dumps(payload))

        restart(client)
        history = client.get(f"/api/versions/{ws}/runs/").json()
        assert run_id in {record["id"] for record in history}

    # Encoded traversal only: an unencoded `../../etc` is normalised away by the
    # client before it is ever sent, so it never reaches the endpoint under test.
    @pytest.mark.parametrize(
        "attack", ["..%2f..%2fetc", "not-a-uuid", "%2e%2e%2f%2e%2e%2fetc", "nope"]
    )
    def test_run_id_must_be_a_uuid(self, client, attack):
        """A run id is joined to a filesystem path, so its shape is checked.

        This surface is new: `run_dir` used to be a dictionary lookup and never
        touched the filesystem, so nothing could be probed through it.
        """
        assert client.get(f"/api/runs/{attack}/").status_code == 404
        assert client.get(f"/api/runs/{attack}/logs/").status_code == 404

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


class TestFrozenConfig:
    """The model definition a run was started from, served read-only."""

    @pytest.fixture
    def finished(self, client, ws):
        run_id = client.post(f"/api/versions/{ws}/runs/").json()["id"]
        wait_for_terminal(client, run_id)
        return run_id

    def test_the_run_reports_a_complete_snapshot(self, client, finished):
        record = client.get(f"/api/runs/{finished}/").json()
        assert record["has_snapshot"] is True
        assert record["snapshot_complete"] is True

        manifest = client.get(f"/api/runs/{finished}/snapshot/").json()
        assert manifest["available"] is True
        assert manifest["total_bytes"] > 0
        assert manifest["external"] == []

    def test_the_file_tree_matches_the_workspace_shape(self, client, finished):
        """Same payload shape as `/versions/{id}/files/`, so one component serves both."""
        entries = client.get(f"/api/runs/{finished}/files/").json()
        paths = {entry["path"] for entry in entries}

        assert "model.yaml" in paths
        assert {"path", "type", "size"} <= set(entries[0])

    def test_frozen_files_are_byte_identical_to_the_workspace(
        self, client, ws, finished
    ):
        live = client.get(f"/api/versions/{ws}/files/model.yaml").json()["content"]
        frozen = client.get(f"/api/runs/{finished}/files/model.yaml").json()["content"]
        assert frozen == live

    def test_editing_the_workspace_does_not_change_the_frozen_copy(
        self, client, ws, finished
    ):
        """The entire point: a run stays readable as it was, not as the model is now."""
        before = client.get(f"/api/runs/{finished}/files/model.yaml").json()["content"]

        client.put(
            f"/api/versions/{ws}/files/model.yaml", json={"content": "wrecked: true\n"}
        )

        after = client.get(f"/api/runs/{finished}/files/model.yaml").json()["content"]
        assert after == before
        assert "wrecked" not in after

    def test_a_frozen_data_table_reads_as_a_grid(self, client, finished):
        entries = client.get(f"/api/runs/{finished}/files/").json()
        csv_path = next(e["path"] for e in entries if e["type"] == "csv")

        body = client.get(f"/api/runs/{finished}/csv/{csv_path}").json()
        assert body["columns"]
        assert body["rows"]

    def test_the_frozen_tree_is_a_model_in_its_own_right(self, client, finished):
        """Enough was captured to describe the model, not just list files."""
        tree = client.get(f"/api/runs/{finished}/component-tree/").json()
        assert "techs" in tree

        graph = client.get(f"/api/runs/{finished}/import-graph/").json()
        assert graph["nodes"]

    def test_there_is_no_way_to_write_to_a_snapshot(self, client, finished):
        """History is not editable."""
        response = client.put(
            f"/api/runs/{finished}/files/model.yaml", json={"content": "no"}
        )
        assert response.status_code == 405

    @pytest.mark.parametrize(
        "attack", ["..%2f..%2f..%2frequest.json", "%2e%2e%2foutcome.json"]
    )
    def test_snapshot_paths_cannot_escape(self, client, finished, attack):
        """`safe_path` guards this root too, not just a workspace."""
        assert client.get(f"/api/runs/{finished}/files/{attack}").status_code == 400

    def test_a_run_without_a_snapshot_answers_rather_than_404ing(
        self, client, ws, national_scale
    ):
        """A pre-snapshot run must be distinguishable from a wrong URL.

        A 404 would mean the frontend could not tell "old run" from "no such run".
        """
        run_id = client.post(f"/api/versions/{ws}/runs/").json()["id"]
        wait_for_terminal(client, run_id)
        run_dir = national_scale / "calligraph" / "runs" / run_id
        shutil.rmtree(run_dir / "snapshot")
        (run_dir / "snapshot.json").unlink()

        manifest = client.get(f"/api/runs/{run_id}/snapshot/")
        assert manifest.status_code == 200
        assert manifest.json()["available"] is False
        assert manifest.json()["reason"]

        assert client.get(f"/api/runs/{run_id}/files/").json() == []
        assert client.get(f"/api/runs/{run_id}/").json()["has_snapshot"] is False


class TestRunOptions:
    def test_no_body_still_starts_a_run(self, client, ws):
        """The frontend sends none today, and must keep working."""
        assert client.post(f"/api/versions/{ws}/runs/").status_code == 201

    def test_options_are_echoed_on_the_record(self, client, ws):
        response = client.post(
            f"/api/versions/{ws}/runs/",
            json={
                "label": "  with a name  ",
                "scenario": "time_resampling",
                "override_dict": {"config": {"init": {"name": "x"}}},
                "build_only": True,
            },
        )
        assert response.status_code == 201
        record = response.json()

        assert record["label"] == "with a name"
        assert record["scenario"] == "time_resampling"
        assert record["build_only"] is True
        assert record["override_dict"] == {"config": {"init": {"name": "x"}}}

    def test_an_unknown_scenario_is_rejected_without_starting_anything(
        self, client, ws, national_scale
    ):
        """Rejected up front, rather than after a subprocess and a stack trace."""
        response = client.post(
            f"/api/versions/{ws}/runs/", json={"scenario": "no_such_scenario"}
        )
        assert response.status_code == 400
        assert "no_such_scenario" in response.json()["detail"]

        # Nothing was created, so a typo leaves no wreckage in the history.
        assert not (national_scale / "calligraph" / "runs").exists()


class TestRenamingAndDeleting:
    @pytest.fixture
    def finished(self, client, ws):
        run_id = client.post(f"/api/versions/{ws}/runs/").json()["id"]
        wait_for_terminal(client, run_id)
        return run_id

    def test_a_run_can_be_renamed(self, client, finished):
        patched = client.patch(f"/api/runs/{finished}/", json={"label": "baseline"})
        assert patched.status_code == 200
        assert patched.json()["label"] == "baseline"
        assert client.get(f"/api/runs/{finished}/").json()["label"] == "baseline"

    def test_renaming_does_not_disturb_the_creation_time(self, client, finished):
        """The label goes in meta.json, so history ordering is untouched."""
        before = client.get(f"/api/runs/{finished}/").json()["created_at"]
        client.patch(f"/api/runs/{finished}/", json={"label": "renamed"})
        assert client.get(f"/api/runs/{finished}/").json()["created_at"] == before

    def test_a_rename_survives_a_restart(self, client, finished):
        client.patch(f"/api/runs/{finished}/", json={"label": "persisted"})
        restart(client)
        assert client.get(f"/api/runs/{finished}/").json()["label"] == "persisted"

    def test_a_run_can_be_deleted(self, client, ws, finished, national_scale):
        assert client.delete(f"/api/runs/{finished}/").status_code == 204

        assert not (national_scale / "calligraph" / "runs" / finished).exists()
        assert client.get(f"/api/runs/{finished}/").status_code == 404
        assert client.get(f"/api/versions/{ws}/runs/").json() == []

    def test_a_running_run_cannot_be_deleted(self, client, ws):
        """Deleting under a live worker would leave it writing into nothing."""
        run_id = client.post(f"/api/versions/{ws}/runs/").json()["id"]

        response = client.delete(f"/api/runs/{run_id}/")
        assert response.status_code == 409
        assert "cancel" in response.json()["detail"].lower()

        client.post(f"/api/runs/{run_id}/cancel/")
        assert client.delete(f"/api/runs/{run_id}/").status_code == 204

    def test_renaming_or_deleting_an_unknown_run_is_404(self, client):
        unknown = "00000000-0000-4000-8000-000000000000"
        assert (
            client.patch(f"/api/runs/{unknown}/", json={"label": "x"}).status_code
            == 404
        )
        assert client.delete(f"/api/runs/{unknown}/").status_code == 404


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

    def test_cancellation_survives_a_restart(self, client, ws):
        """A cancelled run still reads as cancelled after the server restarts.

        Cancellation used to live in a set in memory, so cancelling and then
        restarting reported "failed" with the message "the process is no longer
        present" — technically true, and thoroughly misleading.
        """
        run_id = client.post(f"/api/versions/{ws}/runs/").json()["id"]
        client.post(f"/api/runs/{run_id}/cancel/")

        restart(client)
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
