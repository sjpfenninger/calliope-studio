"""Building and solving models.

These tests really do solve, in a subprocess, with CBC. They are the slowest in
the suite and the most valuable: writing `results.nc` is the only thing
connecting the editor to the analysis half, and it is precisely what the
prototype this code came from failed to do.
"""

import json
import logging
import shutil
import subprocess
import sys
import time

import pytest

from calliope_studio.runs import protocol
from calliope_studio.runs.manager import RunManager, RunRecord

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


def read_stream(client, run_id):
    """Consumes a run's SSE stream to the end, as `[{"event": …, "data": …}]`.

    Every event now carries a JSON body, log lines included, so there is one
    shape to parse rather than a special case for the untyped ones.
    """
    events, name = [], None
    with client.stream("GET", f"/api/runs/{run_id}/logs/") as response:
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        for line in response.iter_lines():
            if line.startswith("event: "):
                name = line.removeprefix("event: ").strip()
            elif line.startswith("data: ") and name:
                events.append(
                    {"event": name, "data": json.loads(line.removeprefix("data: "))}
                )
                if name == "done":
                    break
                name = None
    return events


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
        for it, so a folder gained a `calliope-studio/` before the user had done
        anything at all.
        """
        before = sorted(path.name for path in national_scale.iterdir())

        assert client.get(f"/api/versions/{ws}/runs/").json() == []

        assert sorted(path.name for path in national_scale.iterdir()) == before
        assert not (national_scale / "calliope-studio").exists()

    def test_running_creates_the_directory_with_a_gitignore(
        self, client, ws, national_scale
    ):
        run_id = client.post(f"/api/versions/{ws}/runs/").json()["id"]
        wait_for_terminal(client, run_id)

        data_dir = national_scale / "calliope-studio"
        assert (data_dir / "runs" / run_id).is_dir()
        assert (data_dir / ".gitignore").is_file()

    def test_deep_validation_leaves_nothing_behind(self, client, ws, national_scale):
        """A validation has no artefact worth keeping.

        Each click used to leave a permanent UUID-named directory beside the
        model, unreachable and unremovable from the interface.
        """
        before = sorted(path.name for path in national_scale.iterdir())

        task_id = client.post(f"/api/versions/{ws}/validate/").json()["task_id"]
        wait_for_task(client, task_id)

        assert sorted(path.name for path in national_scale.iterdir()) == before
        assert not (national_scale / "calliope-studio").exists()
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

        results = national_scale / "calliope-studio" / "runs" / run_id / "results.nc"
        assert results.is_file()

        # The file has to be readable by the analysis half, which is the whole
        # point of writing it.
        import calliope

        model = calliope.read_netcdf(str(results))
        assert model.results
        assert "flow_cap" in model.results

    def test_a_failed_run_leaves_no_results_behind(self, tmp_path):
        """A half-written `results.nc` must not survive the failure that caused it.

        Observed for real: `to_netcdf` raised while appending attributes, after
        the model had already solved to optimality, leaving 380 kB of unreadable
        netCDF. The run then reported `has_results`, which mints a results handle,
        which opens the run's tab on charts that fail to load — a broken screen
        instead of the error message that was sitting in the outcome all along.
        """
        from calliope_studio.runs import protocol, worker

        run_dir = tmp_path / "run"
        run_dir.mkdir()
        protocol.RunRequest(
            workspace=str(tmp_path / "nowhere"), model_file="model.yaml"
        ).write(run_dir)
        # Stands in for the partial file the failing call had already created.
        (run_dir / protocol.RESULTS_FILE).write_bytes(b"CDF\x01 truncated")

        assert worker.run(run_dir) == 1
        assert protocol.read_outcome(run_dir)["status"] == "failed"
        assert not (run_dir / protocol.RESULTS_FILE).exists()

    def test_a_run_still_going_offers_no_results_handle(
        self, client, ws, national_scale
    ):
        """`results.nc` existing is not the same as it being readable.

        The worker writes the file, records the outcome and then exits, and until
        it does the file may still be held open. Minting a handle on the file's
        mere existence made the interface open a finished run's charts the moment
        it appeared — and `calliope.read_netcdf` then failed on it, so a run that
        had solved perfectly well showed a broken screen.
        """
        import os

        from calliope_studio.runs import protocol

        run_id = "3fa85f64-5717-4562-b3fc-2c963f66afa6"
        run_dir = national_scale / "calliope-studio" / "runs" / run_id
        run_dir.mkdir(parents=True)
        protocol.RunRequest(workspace=str(national_scale)).write(run_dir)
        (run_dir / protocol.RESULTS_FILE).write_bytes(b"not finished yet")
        # This process stands in for a worker that has not exited: no outcome
        # file, a live pid, so the run reads as still running.
        protocol.write_pid(run_dir, os.getpid())

        record = client.get(f"/api/runs/{run_id}/").json()
        assert record["status"] == "running"
        assert record["has_results"] is True
        assert record["results_handle"] is None

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

        request_file = (
            national_scale / "calliope-studio" / "runs" / run_id / "request.json"
        )
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

        request_file = (
            national_scale / "calliope-studio" / "runs" / run_id / "request.json"
        )
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
        events = read_stream(client, run_id)

        done = next((e for e in events if e["event"] == "done"), None)
        assert done is not None, "stream ended without a done event"
        assert done["data"]["status"] == "success"

        stages = [e["data"]["name"] for e in events if e["event"] == "stage"]
        # Calliope's own divisions, in order — `postprocess` among them, which
        # only Calliope knows the boundaries of.
        assert [
            s for i, s in enumerate(stages) if i == 0 or stages[i - 1] != s
        ] == list(protocol.STAGES)

    def test_stage_events_carry_what_the_stage_is_doing(self, client, ws):
        """The build reports which group of components it is generating."""
        run_id = client.post(f"/api/versions/{ws}/runs/").json()["id"]
        events = read_stream(client, run_id)

        details = {
            e["data"]["detail"]
            for e in events
            if e["event"] == "stage" and e["data"]["name"] == "build"
        }
        assert "constraints" in details
        assert "variables" in details

    def test_log_events_carry_their_level_and_survive_newlines(
        self, client, national_scale
    ):
        """A log line goes out as JSON, not as a bare `data:` string.

        Solvers write their output in multi-line chunks and Calliope logs each
        chunk as one record. Sent raw, SSE ends the event at the newline and
        everything after it is read as unknown fields and discarded — which is
        what used to happen to all but the first line of CBC's output. The level
        and the logger went the same way, so nothing could be coloured either.

        Assembled by hand rather than solved for: this is about the wire format,
        and a real solver's chunking is not the thing under test.
        """
        run_id = "3fa85f64-5717-4562-b3fc-2c963f66afa7"
        run_dir = national_scale / "calliope-studio" / "runs" / run_id
        run_dir.mkdir(parents=True)
        protocol.RunRequest(workspace=str(national_scale)).write(run_dir)
        chunk = "Welcome to the CBC MILP Solver\nVersion: 2.10.13\nBuild Date: May 12"
        protocol.append_event(
            run_dir, {"t": "log", "level": "DEBUG", "logger": "<solve>", "msg": chunk}
        )
        protocol.append_event(run_dir, {"t": "done", "status": "success"})

        logs = [e["data"] for e in read_stream(client, run_id) if e["event"] == "log"]
        assert [(log["level"], log["logger"], log["msg"]) for log in logs] == [
            ("DEBUG", "<solve>", chunk)
        ]

    def test_run_log_is_not_the_only_place_solver_output_lands(self, client, ws):
        """A solved run's log has more in it than Calliope's own INFO lines."""
        run_id = client.post(f"/api/versions/{ws}/runs/").json()["id"]
        wait_for_terminal(client, run_id)

        logs = [e["data"] for e in read_stream(client, run_id) if e["event"] == "log"]
        assert any(log["logger"].endswith("<solve>") for log in logs), (
            "the solver's own output never reached the event stream"
        )

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
        run_dir = national_scale / "calliope-studio" / "runs" / run_id
        shutil.rmtree(run_dir / "snapshot")
        (run_dir / "snapshot.json").unlink()

        manifest = client.get(f"/api/runs/{run_id}/snapshot/")
        assert manifest.status_code == 200
        assert manifest.json()["available"] is False
        assert manifest.json()["reason"]

        assert client.get(f"/api/runs/{run_id}/files/").json() == []
        assert client.get(f"/api/runs/{run_id}/").json()["has_snapshot"] is False


class TestSolvingFromTheSnapshot:
    """ "As written" and "as solved" have to be the same tree.

    The worker used to read the live workspace, so editing a file in the seconds
    between clicking Run and `read_yaml` produced a run whose frozen config was not
    the config that was actually solved.
    """

    def test_a_run_reports_that_it_solved_the_snapshot(self, client, ws):
        run_id = client.post(f"/api/versions/{ws}/runs/").json()["id"]
        record = wait_for_terminal(client, run_id)
        assert record["status"] == "success", record.get("error")
        assert record["solved_from"] == "snapshot"

    def test_wrecking_the_workspace_after_starting_does_not_affect_the_run(
        self, client, ws, national_scale
    ):
        """The whole point of freezing before the worker exists.

        `POST` returns once the child is spawned, well before it has imported
        Calliope, so this really does overwrite the model mid-flight. Reading the
        live workspace would fail the run; reading the snapshot cannot.
        """
        run_id = client.post(f"/api/versions/{ws}/runs/").json()["id"]

        (national_scale / "model.yaml").write_text("this: is not a model\n")

        record = wait_for_terminal(client, run_id)
        assert record["status"] == "success", record.get("error")
        assert record["solved_from"] == "snapshot"

    def test_an_incomplete_snapshot_falls_back_to_the_workspace(
        self, client, ws, national_scale
    ):
        """A model referring outside its folder is not freezable, and must still run.

        Failing a run that would otherwise have worked, in the name of purity,
        would be the wrong trade.
        """
        outside = national_scale.parent / "outside.yaml"
        outside.write_text("techs: {}\n")
        model = national_scale / "model.yaml"
        model.write_text(
            model.read_text().replace("import:", 'import:\n  - "../outside.yaml"', 1)
        )

        run_id = client.post(f"/api/versions/{ws}/runs/").json()["id"]
        record = wait_for_terminal(client, run_id)

        assert record["snapshot_complete"] is False
        assert record["solved_from"] == "workspace"
        assert record["status"] == "success", record.get("error")

    def test_urban_scale_solves_from_its_snapshot(self, urban_scale, storage):
        """The `math_paths` case, end to end.

        `urban_scale` reaches `additional_math.yaml` through `config.init.
        math_paths`, which the import graph cannot see. If the snapshot missed it,
        solving from the snapshot would fail here and nowhere else.
        """
        from fastapi.testclient import TestClient

        from calliope_studio.server.app import create_app

        app = create_app(workspace=urban_scale, storage=storage)
        with TestClient(app) as urban_client:
            ws = storage.open(urban_scale).id
            run_id = urban_client.post(f"/api/versions/{ws}/runs/").json()["id"]
            record = wait_for_terminal(urban_client, run_id)

        assert record["status"] == "success", record.get("error")
        assert record["solved_from"] == "snapshot"
        assert record["snapshot_complete"] is True


class TestListingSurvivesPruning:
    def test_a_run_deleted_mid_listing_does_not_break_the_list(self):
        """History is capped when a run *starts*, not when one finishes.

        So a listing already holding the records can be asked about one whose
        directory has just been pruned away, and `run_dir` then raises. Observed:
        one `KeyError` turned the whole run list into a 500, which empties the
        sidebar over a single run that no longer exists.
        """
        from calliope_studio.server.routes.runs import _with_results

        class Gone:
            def run_dir(self, run_id):
                raise KeyError(run_id)

        record = RunRecord(
            id="082faa2b-f781-477a-b5d7-6059146ffac8",
            status="success",
            created_at="2026-07-28T12:00:00+00:00",
            has_results=True,
        )

        payload = _with_results(record, Gone(), store=None)
        assert payload["results_handle"] is None
        assert payload["status"] == "success"


class TestScenarioCatalogEndpoint:
    """What the Run sidebar's picker is offered. Reads only; starts nothing."""

    def test_the_endpoint_lists_what_the_model_defines(self, client, ws):
        catalog = client.get(f"/api/versions/{ws}/scenarios/").json()
        assert "cold_fusion_with_production_share" in {
            entry["name"] for entry in catalog["scenarios"]
        }
        assert "time_resampling" in {entry["name"] for entry in catalog["overrides"]}

    def test_a_scenario_carries_what_it_composes(self, client, ws):
        catalog = client.get(f"/api/versions/{ws}/scenarios/").json()
        entry = next(
            entry
            for entry in catalog["scenarios"]
            if entry["name"] == "cold_fusion_with_production_share"
        )
        assert entry["overrides"] == ["cold_fusion", "cold_fusion_prod_share"]
        # Both of national_scale's scenarios name overrides that are commented
        # out in its own file, and the picker says so rather than offering a
        # name that cannot run.
        assert entry["missing"] == ["cold_fusion_prod_share"]

    def test_a_new_override_is_offered_and_stops_being_rejected(
        self, client, ws, national_scale
    ):
        """The picker and the validator move together, on the same edit."""
        rejected = client.post(
            f"/api/versions/{ws}/runs/", json={"scenario": "midweek"}
        )
        assert rejected.status_code == 400

        scenarios_yaml = national_scale / "scenarios.yaml"
        scenarios_yaml.write_text(
            scenarios_yaml.read_text()
            + "\n  midweek:\n"
            + '    config.init.subset.timesteps: ["2005-01-05", "2005-01-06"]\n'
        )

        catalog = client.get(f"/api/versions/{ws}/scenarios/").json()
        assert "midweek" in {entry["name"] for entry in catalog["overrides"]}

        accepted = client.post(
            f"/api/versions/{ws}/runs/",
            json={"scenario": "midweek", "build_only": True},
        )
        assert accepted.status_code == 201


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
        assert not (national_scale / "calliope-studio" / "runs").exists()


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

        assert not (national_scale / "calliope-studio" / "runs" / finished).exists()
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


class TestRetention:
    """How much history to keep is the user's decision, made visible.

    Runs were previously capped at a constant nobody could see or change, in a
    directory the user is now told to look at.
    """

    def test_the_setting_round_trips(self, client, ws):
        assert client.get(f"/api/versions/{ws}/settings/").json() == {
            "run_retention": 20
        }

        patched = client.patch(
            f"/api/versions/{ws}/settings/", json={"run_retention": 3}
        )
        assert patched.status_code == 200
        assert patched.json() == {"run_retention": 3}
        assert client.get(f"/api/versions/{ws}/settings/").json()["run_retention"] == 3

    def test_changing_the_setting_deletes_nothing(self, client, ws, national_scale):
        """Lowering the limit must not be a destructive act in itself.

        Pruning happens when a run starts. A settings screen that silently
        deleted results as you moved a number would be a trap.
        """
        run_id = client.post(f"/api/versions/{ws}/runs/").json()["id"]
        wait_for_terminal(client, run_id)

        client.patch(f"/api/versions/{ws}/settings/", json={"run_retention": 1})
        assert (national_scale / "calliope-studio" / "runs" / run_id).is_dir()

    def test_a_lowered_limit_prunes_on_the_next_run(self, client, ws):
        first = client.post(f"/api/versions/{ws}/runs/").json()["id"]
        wait_for_terminal(client, first)
        second = client.post(f"/api/versions/{ws}/runs/").json()["id"]
        wait_for_terminal(client, second)

        client.patch(f"/api/versions/{ws}/settings/", json={"run_retention": 1})
        third = client.post(f"/api/versions/{ws}/runs/").json()["id"]
        wait_for_terminal(client, third)

        history = {
            record["id"] for record in client.get(f"/api/versions/{ws}/runs/").json()
        }
        assert first not in history
        assert third in history

    def test_keeping_everything_prunes_nothing(self, client, ws):
        client.patch(f"/api/versions/{ws}/settings/", json={"run_retention": None})
        first = client.post(f"/api/versions/{ws}/runs/").json()["id"]
        wait_for_terminal(client, first)
        second = client.post(f"/api/versions/{ws}/runs/").json()["id"]
        wait_for_terminal(client, second)

        history = {
            record["id"] for record in client.get(f"/api/versions/{ws}/runs/").json()
        }
        assert {first, second} <= history


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
    """The build tier: `read_yaml` plus `build()`, in the worker subprocess.

    Reached only through the one validate endpoint, and only when the syntax
    tier came back clean.
    """

    def test_valid_model_reports_no_errors(self, client, ws):
        task_id = client.post(f"/api/versions/{ws}/validate/").json()["task_id"]
        assert wait_for_task(client, task_id) == {"errors": []}

    def test_semantically_broken_model_reports_errors(self, client, ws, national_scale):
        # Syntactically fine, but not a technology Calliope will accept.
        techs = national_scale / "model_config" / "techs.yaml"
        techs.write_text(
            techs.read_text().replace("base_tech: supply", "base_tech: nonsense", 1)
        )

        task_id = client.post(f"/api/versions/{ws}/validate/").json()["task_id"]
        result = wait_for_task(client, task_id)
        assert result["errors"], "expected an invalid base_tech to be reported"
        assert result["errors"][0]["severity"] == "error"
        assert result["errors"][0]["tier"] == "build"
        # Calliope reports no line numbers, and saying otherwise would make the
        # frontend offer a jump that goes nowhere.
        assert result["errors"][0]["line"] is None

    def test_cancelling_reports_no_problems(self, client, ws):
        """A cancelled validation has no answer, which is not a clean one.

        Reporting the kill as an error would tell the user their model is broken
        because they stopped waiting for it.
        """
        task_id = client.post(f"/api/versions/{ws}/validate/").json()["task_id"]
        assert client.post(f"/api/tasks/{task_id}/cancel/").status_code == 200
        assert wait_for_task(client, task_id) == {"errors": []}

    def test_unknown_task_is_404(self, client):
        assert client.get("/api/tasks/nope/").status_code == 404
        assert client.post("/api/tasks/nope/cancel/").status_code == 404


class TestStdioCapture:
    """Whatever the worker's stdout receives, the log receives.

    Calliope routes a Pyomo solver's output into a logger, but it does so with
    `redirect_stdout`, which only rebinds `sys.stdout`. Gurobi writes from the C
    library straight to file descriptor 1 and goes straight past it, which is why
    the capture is at descriptor level — and why this has to be tested in a real
    process rather than in pytest's captured one.
    """

    SCRIPT = """
import os, sys
from pathlib import Path
from calliope_studio.runs.worker import _capture_stdio

with _capture_stdio(Path(sys.argv[1])):
    os.write(1, b"Gurobi 12.0 (mac64[arm]) logging in\\n")   # as a C library does
    print("and a plain print")
    print("on standard error", file=sys.stderr)
"""

    @pytest.fixture
    def run_dir(self, tmp_path):
        directory = tmp_path / "run"
        directory.mkdir()
        protocol.RunRequest(workspace=str(tmp_path)).write(directory)
        return directory

    def emitted(self, run_dir):
        with open(run_dir / protocol.LOG_FILE, "w") as log_file:
            subprocess.run(
                [sys.executable, "-c", self.SCRIPT, str(run_dir)],
                stdout=log_file,
                stderr=subprocess.STDOUT,
                check=True,
            )
        return [e for e in protocol.read_events(run_dir) if e.get("t") == "log"]

    def test_a_c_level_write_becomes_a_log_event(self, run_dir):
        events = self.emitted(run_dir)
        messages = [event["msg"] for event in events]
        assert "Gurobi 12.0 (mac64[arm]) logging in" in messages
        assert "and a plain print" in messages
        assert "on standard error" in messages
        # At the level Calliope's own solver records use, so that turning the
        # solver's output down quietens every solver rather than only the ones
        # whose output happens to arrive through a logger.
        assert {event["level"] for event in events} == {"DEBUG"}

    def test_run_log_still_receives_everything(self, run_dir):
        """The backstop stays a backstop: capturing must not divert."""
        self.emitted(run_dir)
        written = (run_dir / protocol.LOG_FILE).read_text()
        assert "Gurobi 12.0 (mac64[arm]) logging in" in written
        assert "and a plain print" in written

    def test_output_past_the_cap_stops_at_the_event_stream(self, run_dir, monkeypatch):
        """`events.jsonl` is replayed in full to every client, so it is bounded."""
        script = """
import sys
from pathlib import Path
from calliope_studio.runs import worker

worker.MAX_STDIO_LINES = 3
with worker._capture_stdio(Path(sys.argv[1])):
    for i in range(20):
        print("line", i)
"""
        with open(run_dir / protocol.LOG_FILE, "w") as log_file:
            subprocess.run(
                [sys.executable, "-c", script, str(run_dir)],
                stdout=log_file,
                stderr=subprocess.STDOUT,
                check=True,
            )

        messages = [
            event["msg"] for event in protocol.read_events(run_dir) if event.get("t")
        ]
        assert messages[:3] == ["line 0", "line 1", "line 2"]
        assert messages[3] == f"[output continues in {protocol.LOG_FILE}]"
        assert len(messages) == 4
        # Nothing was dropped from the file the notice points at.
        assert "line 19" in (run_dir / protocol.LOG_FILE).read_text()


class TestLogNoise:
    """What a log the user is meant to read must not be full of."""

    def test_a_repeated_warning_is_recorded_once(self, tmp_path):
        """Building `national_scale` raises 365 warnings, six of them distinct.

        The same pyparsing deprecation 81 times and the same xarray one 90 times
        buried Calliope's own account of the run — eight lines of it — under a
        wall of identical text. Deduplicated in the handler rather than with
        `warnings.simplefilter("once")`, which by the time a solve is under way
        has been undone by somebody's `catch_warnings` block.
        """
        from calliope_studio.runs.stages import StageTracker
        from calliope_studio.runs.worker import WARNINGS_LOGGER, EventLogHandler

        run_dir = tmp_path / "run"
        run_dir.mkdir()
        handler = EventLogHandler(run_dir, StageTracker())

        def record(name, message):
            return logging.LogRecord(
                name, logging.WARNING, __file__, 1, message, (), None
            )

        for _ in range(50):
            handler.emit(record(WARNINGS_LOGGER, "'oneOf' deprecated - use 'one_of'"))
        handler.emit(record(WARNINGS_LOGGER, "a different warning"))
        # Only warnings are deduplicated: a solver repeating itself is the log.
        for _ in range(3):
            handler.emit(record("calliope.model", "Running SPORE 1."))

        messages = [event["msg"] for event in protocol.read_events(run_dir)]
        assert messages == [
            "'oneOf' deprecated - use 'one_of'",
            "a different warning",
            "Running SPORE 1.",
            "Running SPORE 1.",
            "Running SPORE 1.",
        ]
