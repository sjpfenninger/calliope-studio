"""Version tracking over HTTP.

The cases here are the ones a route can get wrong on its own, with the
`vcs` layer working perfectly underneath: a state reported as a boolean when
it has four values, a path reaching git unresolved, a sha spliced into a
revision unchecked, a discard of a file that has no changes, and a run that
was asked to commit first and quietly did not.
"""

from __future__ import annotations

import time
import uuid
from pathlib import Path

import pytest

from calliope_studio.runs import protocol
from calliope_studio.server import mode
from calliope_studio.server.routes.runs import (
    DEFAULT_CHECKPOINT_MESSAGE,
    RunOptions,
    _checkpoint,
)
from calliope_studio.server.storage import LocalStorage
from calliope_studio.vcs import command, init, log, repo, status
from calliope_studio.vcs.command import git_available

pytestmark = pytest.mark.skipif(not git_available(), reason="git is not installed")


@pytest.fixture(autouse=True)
def _hermetic(hermetic_git):
    return hermetic_git


@pytest.fixture
def ws(client):
    return client.workspace_id


@pytest.fixture
def tracked(client, ws, national_scale):
    """The workspace under version control, with its first commit made."""
    response = client.post(f"/api/versions/{ws}/vcs/init/")
    assert response.status_code == 200, response.text
    return repo.discover(national_scale)


def vcs(client, ws, what="", **params):
    return client.get(f"/api/versions/{ws}/vcs/{what}", params=params)


def edit(client, ws, path, content):
    response = client.put(f"/api/versions/{ws}/files/{path}", json={"content": content})
    assert response.status_code == 200, response.text


class TestStates:
    def test_a_plain_folder_is_offered_rather_than_initialised(
        self, client, ws, national_scale
    ):
        payload = vcs(client, ws).json()
        assert payload["available"] is True
        assert payload["tracked"] is False
        assert payload["state"] == "untracked"
        assert not (national_scale / ".git").exists()

    def test_health_says_whether_there_is_a_git_to_use(self, client):
        assert client.get("/api/health").json()["capabilities"]["vcs"] is True

    def test_init_makes_the_folder_ready(self, client, ws, national_scale):
        payload = client.post(f"/api/versions/{ws}/vcs/init/").json()
        assert payload["state"] == "ready"
        assert payload["branch"] == "main"
        assert payload["changed"] == 0
        assert payload["head"]
        assert (national_scale / ".gitignore").is_file()
        assert client.post(f"/api/versions/{ws}/vcs/init/").status_code == 409

    def test_an_ignored_folder_is_named_as_such(self, client, ws, national_scale):
        """The state `pixi run serve` opens: a repository around the model
        that ignores it. A healthy-looking empty list would be a lie."""
        parent = national_scale.parent
        command.run(["init", "-q"], parent)
        (parent / ".gitignore").write_text("national_scale/\n", encoding="utf-8")
        command.run(["add", "-A", "--", "."], parent)
        command.run(["commit", "-q", "-m", "paper"], parent)

        payload = vcs(client, ws).json()
        assert payload["state"] == "ignored"
        assert payload["tracked"] is False
        assert payload["nested"] is True
        assert Path(payload["root"]) == parent.resolve()
        assert vcs(client, ws, "changes/").status_code == 409

    def test_without_git_the_feature_is_absent(self, client, ws, monkeypatch):
        monkeypatch.setattr(command, "git_executable", lambda: None)
        payload = vcs(client, ws).json()
        assert payload == {
            "available": False,
            "tracked": False,
            "state": "no_git",
            "root": None,
            "branch": None,
            "detached": False,
            "nested": False,
            "changed": 0,
            "head": None,
            "gitignore": None,
        }
        # Health reports capabilities decided when the app was created, so the
        # decision is checked where it is made rather than through a payload
        # this test cannot rebuild.
        assert mode._capabilities(editable=True)["vcs"] is False
        assert client.post(f"/api/versions/{ws}/vcs/init/").status_code == 409

    def test_the_offer_shows_what_it_would_write(self, client, ws, national_scale):
        """The dialog shows the ignore file *from the server*, so what is
        promised and what is written are one string."""
        assert "*.nc" in vcs(client, ws).json()["gitignore"]
        (national_scale / ".gitignore").write_text("mine\n", encoding="utf-8")
        assert vcs(client, ws).json()["gitignore"] is None

    def test_a_missing_identity_is_an_actionable_400(self, client, ws, hermetic_git):
        hermetic_git.write_text("", encoding="utf-8")
        response = client.post(f"/api/versions/{ws}/vcs/init/")
        assert response.status_code == 400
        assert "user.email" in response.json()["detail"]


class TestChanges:
    def test_an_edit_and_a_new_file_are_listed(self, client, ws, tracked):
        edit(client, ws, "model.yaml", "name: edited\n")
        edit(client, ws, "notes.md", "# notes\n")

        payload = vcs(client, ws, "changes/").json()
        assert {entry["path"]: entry["state"] for entry in payload["files"]} == {
            "model.yaml": "modified",
            "notes.md": "untracked",
        }
        assert vcs(client, ws).json()["changed"] == 2

    def test_the_working_diff_shows_both_sides(self, client, ws, tracked):
        edit(client, ws, "model.yaml", "name: edited\n")
        payload = vcs(client, ws, "diff/", path="model.yaml").json()
        assert payload["modified"] == "name: edited\n"
        assert payload["original"] != payload["modified"]
        assert payload["original_exists"] and payload["modified_exists"]
        assert payload["binary"] is False

    def test_a_traversal_is_refused_before_git_sees_it(self, client, ws, tracked):
        assert vcs(client, ws, "diff/", path="../secret").status_code == 400
        assert vcs(client, ws, "diff/", path=".").status_code == 400

    def test_a_sha_is_checked_before_it_is_spliced(self, client, ws, tracked):
        assert (
            vcs(client, ws, "diff/", path="model.yaml", sha="HEAD^").status_code == 400
        )
        assert vcs(client, ws, "commits/main/").status_code == 400
        assert vcs(client, ws, "commits/deadbeef/").status_code == 404


class TestCommit:
    def test_everything_then_history(self, client, ws, tracked):
        edit(client, ws, "model.yaml", "name: edited\n")
        response = client.post(
            f"/api/versions/{ws}/vcs/commit/", json={"message": "Rename the model"}
        )
        assert response.status_code == 200, response.text
        sha = response.json()["sha"]

        assert vcs(client, ws, "changes/").json()["files"] == []
        commits = vcs(client, ws, "log/").json()["commits"]
        assert [entry["subject"] for entry in commits][:1] == ["Rename the model"]
        assert commits[0]["sha"] == sha

        detail = vcs(client, ws, f"commits/{sha}/").json()
        assert detail["commit"]["subject"] == "Rename the model"
        assert detail["parent"]
        assert [entry["path"] for entry in detail["files"]] == ["model.yaml"]

        shown = vcs(client, ws, "diff/", path="model.yaml", sha=sha).json()
        assert shown["modified"] == "name: edited\n"

    def test_only_the_paths_named(self, client, ws, tracked):
        edit(client, ws, "model.yaml", "name: edited\n")
        edit(client, ws, "scenarios.yaml", "overrides: {}\n")
        client.post(
            f"/api/versions/{ws}/vcs/commit/",
            json={"message": "One", "paths": ["model.yaml"]},
        )
        assert [
            entry["path"] for entry in vcs(client, ws, "changes/").json()["files"]
        ] == ["scenarios.yaml"]

    def test_an_empty_message_and_an_empty_commit_are_refused(
        self, client, ws, tracked
    ):
        assert (
            client.post(
                f"/api/versions/{ws}/vcs/commit/", json={"message": ""}
            ).status_code
            == 422
        )
        response = client.post(f"/api/versions/{ws}/vcs/commit/", json={"message": "x"})
        assert response.status_code == 400
        assert "nothing to commit" in response.json()["detail"].lower()

    def test_a_path_outside_the_model_is_refused(self, client, ws, tracked):
        response = client.post(
            f"/api/versions/{ws}/vcs/commit/",
            json={"message": "x", "paths": ["../elsewhere"]},
        )
        assert response.status_code == 400

    def test_a_log_for_one_file(self, client, ws, tracked):
        edit(client, ws, "model.yaml", "name: edited\n")
        client.post(f"/api/versions/{ws}/vcs/commit/", json={"message": "Model only"})
        commits = vcs(client, ws, "log/", path="scenarios.yaml").json()["commits"]
        assert [entry["subject"] for entry in commits] == [init.INITIAL_MESSAGE]


class TestDiscard:
    def test_a_modified_file_goes_back(self, client, ws, tracked, national_scale):
        before = (national_scale / "model.yaml").read_text(encoding="utf-8")
        edit(client, ws, "model.yaml", "name: edited\n")
        response = client.post(
            f"/api/versions/{ws}/vcs/discard/", json={"path": "model.yaml"}
        )
        assert response.status_code == 204
        assert (national_scale / "model.yaml").read_text(encoding="utf-8") == before

    def test_an_untracked_file_is_removed(self, client, ws, tracked, national_scale):
        edit(client, ws, "notes.md", "x\n")
        client.post(f"/api/versions/{ws}/vcs/discard/", json={"path": "notes.md"})
        assert not (national_scale / "notes.md").exists()

    def test_a_clean_file_has_nothing_to_discard(self, client, ws, tracked):
        response = client.post(
            f"/api/versions/{ws}/vcs/discard/", json={"path": "model.yaml"}
        )
        assert response.status_code == 404

    def test_an_excluded_path_is_refused(self, client, ws, tracked):
        response = client.post(
            f"/api/versions/{ws}/vcs/discard/",
            json={"path": "calliope-studio/runs/x/snapshot/model.yaml"},
        )
        assert response.status_code == 400


class TestRunCheckpoint:
    """The one place the model half of the app meets git."""

    @pytest.fixture
    def workspace(self, storage: LocalStorage, national_scale):
        return storage.open(national_scale)

    def test_an_untracked_folder_records_nothing(self, workspace):
        assert _checkpoint(workspace, RunOptions()) is None

    def test_asking_to_commit_an_untracked_folder_is_refused(self, workspace):
        with pytest.raises(Exception) as caught:
            _checkpoint(workspace, RunOptions(commit_first=True))
        assert caught.value.status_code == 400

    def test_a_clean_tree_records_its_head(self, workspace, national_scale):
        found = init.init(national_scale)
        recorded = _checkpoint(workspace, RunOptions())
        assert recorded == {
            "sha": repo.head(found),
            "short": repo.head(found)[:7],
            "branch": "main",
            "dirty": False,
        }

    def test_a_dirty_tree_says_so(self, workspace, national_scale):
        init.init(national_scale)
        (national_scale / "model.yaml").write_text("name: edited\n", encoding="utf-8")
        assert _checkpoint(workspace, RunOptions())["dirty"] is True

    def test_committing_first_makes_the_sha_name_what_ran(
        self, workspace, national_scale
    ):
        found = init.init(national_scale)
        (national_scale / "model.yaml").write_text("name: edited\n", encoding="utf-8")
        recorded = _checkpoint(workspace, RunOptions(commit_first=True))
        assert recorded["dirty"] is False
        assert status.changes(found) == []
        newest = log.log(found)[0]
        assert newest.sha == recorded["sha"]
        assert newest.subject == DEFAULT_CHECKPOINT_MESSAGE

    def test_a_given_message_is_used(self, workspace, national_scale):
        found = init.init(national_scale)
        (national_scale / "model.yaml").write_text("name: edited\n", encoding="utf-8")
        _checkpoint(
            workspace, RunOptions(commit_first=True, commit_message="Before run 3")
        )
        assert log.log(found)[0].subject == "Before run 3"

    def test_a_run_started_with_commit_first_records_the_commit_it_made(
        self, client, ws, national_scale
    ):
        """Through the route, worker and all. The dict the checkpoint writes
        has to survive `RunRequest.write`, the freeze and `RunRecord`'s
        re-derivation from disk, and calling `_checkpoint` directly exercises
        none of them. `build_only`, so it is seconds rather than a solve."""
        found = init.init(national_scale)
        target = national_scale / "model.yaml"
        target.write_text(
            target.read_text(encoding="utf-8") + "\n# checkpoint\n", encoding="utf-8"
        )

        response = client.post(
            f"/api/versions/{ws}/runs/",
            json={
                "commit_first": True,
                "commit_message": "Checkpoint",
                "build_only": True,
            },
        )
        assert response.status_code == 201, response.text
        record = response.json()
        try:
            assert record["git"]["dirty"] is False
            assert record["git"]["sha"] == repo.head(found)
            assert record["git"]["branch"] == "main"
            assert log.log(found)[0].subject == "Checkpoint"
            # The run directory that appeared is ignored by its own file.
            assert status.changes(found) == []
            # Re-derived from disk, not echoed from the response.
            assert (
                client.get(f"/api/runs/{record['id']}/").json()["git"] == record["git"]
            )
        finally:
            _wait_for_terminal(client, record["id"])

    def test_the_run_record_echoes_it(self, client, ws, national_scale):
        """Written into `request.json` by the server, read back by `runs`."""
        run_id = str(uuid.uuid4())
        run_dir = national_scale / "calliope-studio" / "runs" / run_id
        run_dir.mkdir(parents=True)
        recorded = {
            "sha": "a" * 40,
            "short": "aaaaaaa",
            "branch": "main",
            "dirty": True,
        }
        protocol.RunRequest(workspace=str(national_scale), git=recorded).write(run_dir)
        protocol.write_outcome(run_dir, {"status": "cancelled"})

        payload = client.get(f"/api/runs/{run_id}/").json()
        assert payload["git"] == recorded


def _wait_for_terminal(client, run_id: str, timeout: float = 300) -> None:
    """Lets the worker finish, so a test never leaves a subprocess behind."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        record = client.get(f"/api/runs/{run_id}/").json()
        if record["status"] in ("success", "infeasible", "failed", "cancelled"):
            return
        time.sleep(0.5)
    pytest.fail(f"run {run_id} did not finish within {timeout}s")
