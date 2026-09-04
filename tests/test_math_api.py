"""The math route, end to end: render, poll, keep, and answer again.

`routes/math.py` has two memories and the distinction between them is the whole
route. `_RENDERED` is this process's record of the task that last rendered a
workspace, keyed on the *files'* fingerprint, so an unchanged model is answered
without a subprocess. The on-disk cache (`runs.mathcache`) is keyed on what the
LaTeX backend actually reads, so it survives a restart and a comment. Every
case here drives a real `math_only` worker — about four seconds on
`national_scale` — because the `math_only` mode ran in no Python test before.
"""

import time

import pytest

from calliope_studio.runs import mathcache, protocol
from calliope_studio.server.app import create_app
from calliope_studio.server.routes import math as math_route


@pytest.fixture
def ws(client):
    return client.workspace_id


def wait_for_render(client, ws, task_id, timeout=120):
    """Polls a rendering to `done`, returning the whole envelope."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        body = client.get(f"/api/versions/{ws}/math/{task_id}/").json()
        if body["status"] == "done":
            return body
        time.sleep(0.25)
    pytest.fail(f"rendering {task_id} did not finish within {timeout}s")


def render(client, ws):
    """Starts a rendering and follows it to the end."""
    started = client.post(f"/api/versions/{ws}/math/")
    assert started.status_code == 202, started.text
    body = started.json()
    if body["status"] == "done":
        return body
    return wait_for_render(client, ws, body["task_id"])


def wait_for_resolution(client, ws, timeout=120):
    """Waits until the resolver holds a fresh reading of the workspace.

    `/geo/` is the route that starts and follows a resolve; `_from_disk` refuses
    anything but a resolved model, so the on-disk cache cannot answer before this.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        if client.get(f"/api/versions/{ws}/geo/").json().get("source") == "resolved":
            return
        time.sleep(0.25)
    pytest.fail("the workspace was never resolved")


def scratch_dirs(client):
    return sorted(path.name for path in client.app.state.storage.math_dir().glob("*/"))


class TestARendering:
    def test_a_render_runs_as_a_task_and_answers_when_done(self, client, ws):
        started = client.post(f"/api/versions/{ws}/math/").json()

        assert started["status"] == "running"
        assert started["result"] is None
        assert len(started["fingerprint"]) == 16
        body = wait_for_render(client, ws, started["task_id"])

        assert body["task_id"] == started["task_id"]
        assert body["fingerprint"] == started["fingerprint"]
        payload = body["result"]
        assert set(payload) >= {"mode", "priority", "objective", "groups"}
        # Every equation either has notation or says why it has none. Symbols
        # (parameters, lookups) are listed for being referred to and may
        # carry no notation of their own.
        for group in payload["groups"]:
            if group["key"] in ("parameters", "lookups"):
                continue
            for component in group["components"]:
                assert (
                    "latex" in component
                    or component.get("unmatched")
                    or component.get("deactivated")
                ), component["name"]

    def test_a_finished_render_is_kept_for_the_next_session(self, client, ws):
        body = render(client, ws)
        runs = client.app.state.runs
        run_dir = runs.run_dir(body["task_id"])
        key = (run_dir / protocol.MATH_KEY_FILE).read_text(encoding="utf-8").strip()

        directory = client.app.state.storage.math_cache_dir()
        assert mathcache.read(directory, key) == body["result"]

    def test_the_same_model_is_answered_from_memory_without_a_task(self, client, ws):
        first = render(client, ws)
        before = scratch_dirs(client)

        again = client.post(f"/api/versions/{ws}/math/").json()

        assert again["status"] == "done"
        assert again["task_id"] == first["task_id"]
        assert again["result"] == first["result"]
        assert scratch_dirs(client) == before, "a second task was started"

    def test_a_pruned_scratch_directory_means_rendering_again_not_failing(
        self, client, ws
    ):
        first = render(client, ws)
        runs = client.app.state.runs
        # What `prune_math` does to the oldest, done by hand to the newest.
        import shutil

        shutil.rmtree(runs.run_dir(first["task_id"]))
        assert math_route._read_payload(runs, first["task_id"]) is None

        # Not from disk either: the resolver has no fresh reading yet.
        again = client.post(f"/api/versions/{ws}/math/").json()
        assert again["status"] in ("running", "done")
        if again["status"] == "running":
            assert again["task_id"] != first["task_id"]


class TestTheTwoCaches:
    def test_a_comment_moves_the_file_digest_but_not_the_rendering(
        self, client, ws, national_scale, monkeypatch
    ):
        """The distinction the route exists for.

        A comment changes the files, so `_RENDERED` no longer answers; it cannot
        change the notation, so the on-disk entry still does — and the hit runs
        the math's `checks:` against the current data on its way out.
        """
        first = render(client, ws)
        model = national_scale / "model.yaml"
        model.write_text(
            model.read_text(encoding="utf-8") + "\n# a note\n", encoding="utf-8"
        )
        wait_for_resolution(client, ws)
        checked = []
        real = math_route.mathdoc.check_inputs
        monkeypatch.setattr(
            math_route.mathdoc, "check_inputs", lambda m: checked.append(m) or real(m)
        )

        again = client.post(f"/api/versions/{ws}/math/").json()

        assert again["status"] == "done"
        assert again["task_id"] is None, "answered by a task rather than from disk"
        assert again["fingerprint"] != first["fingerprint"]
        assert again["result"] == first["result"]
        assert checked, "a hit must still run the checks"

    def test_a_restart_is_answered_from_disk(self, client, ws, national_scale, storage):
        first = render(client, ws)
        wait_for_resolution(client, ws)

        math_route._RENDERED.clear()
        from fastapi.testclient import TestClient

        with TestClient(create_app(workspace=national_scale, storage=storage)) as fresh:
            fresh_ws = storage.open(national_scale).id
            wait_for_resolution(fresh, fresh_ws)
            again = fresh.post(f"/api/versions/{fresh_ws}/math/").json()

        assert again["status"] == "done"
        assert again["task_id"] is None
        assert again["result"] == first["result"]


class TestFailures:
    def test_a_cancelled_render_reports_the_cancel_and_is_not_remembered(
        self, client, ws
    ):
        started = client.post(f"/api/versions/{ws}/math/").json()
        task_id = started["task_id"]
        assert client.post(f"/api/tasks/{task_id}/cancel/").status_code == 200

        body = wait_for_render(client, ws, task_id)

        assert body["result"] is None
        assert "cancel" in body["error"].lower()
        assert ws not in math_route._RENDERED

    def test_an_unknown_task_is_a_404(self, client, ws):
        assert client.get(f"/api/versions/{ws}/math/nope/").status_code == 404

    def test_the_sources_endpoint_reports_a_malformed_declaration(
        self, client, ws, national_scale
    ):
        model = national_scale / "model.yaml"
        model.write_text(
            model.read_text(encoding="utf-8").replace(
                "  init:\n", "  init:\n    extra_math: mine\n", 1
            ),
            encoding="utf-8",
        )

        body = client.get(f"/api/versions/{ws}/math/sources/").json()

        kinds = {source["name"]: source["kind"] for source in body["sources"]}
        assert kinds["extra_math"] == "malformed"
        assert "m" not in kinds
        assert len(body["fingerprint"]) == 16
