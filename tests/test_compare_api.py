"""Comparing two versions of one model, over HTTP.

The interesting cases are not "does it find a changed file" but the ones where
a comparison could quietly say something false: a scratch file beside the model
reported as newly added, a run from another model half-compared, a scenario
that no longer exists silently ignored, or two versions that differ being
called identical.

Runs are fabricated on disk rather than solved. A run *is* a directory with a
`request.json` and a frozen tree, and building one directly is what lets a test
say "a run that failed" or "a run whose snapshot is incomplete" without
arranging for a solver to fail.
"""

import uuid
from pathlib import Path

import pytest

from calliope_studio.modeldef.snapshot import write_snapshot
from calliope_studio.runs import protocol
from calliope_studio.server.compare import BadRef, Ref, format_ref, parse_ref


def make_run(model: Path, *, scenario=None, label=None, snapshot=True) -> str:
    """A run directory as the worker would have left it, minus the solving."""
    run_id = str(uuid.uuid4())
    run_dir = model / "calliope-studio" / "runs" / run_id
    run_dir.mkdir(parents=True)
    protocol.RunRequest(workspace=str(model), scenario=scenario, label=label).write(
        run_dir
    )
    if snapshot:
        manifest = write_snapshot(model, run_dir / protocol.SNAPSHOT_DIR)
        protocol.write_snapshot_manifest(run_dir, manifest)
    protocol.write_outcome(run_dir, {"status": "cancelled"})
    return run_id


def compare(client, ws, a, b, what="", **params):
    suffix = f"{what}/" if what else ""
    return client.get(
        f"/api/versions/{ws}/compare/{suffix}", params={"a": a, "b": b, **params}
    )


def statuses(payload) -> dict:
    return {entry["path"]: entry["status"] for entry in payload["files"]}


@pytest.fixture
def ws(client):
    """The workspace id the test client has open."""
    return client.workspace_id


@pytest.fixture
def run_id(client, national_scale):
    """A run that froze the model exactly as the workspace still has it."""
    return make_run(national_scale)


class TestReferences:
    """The grammar of a side, which is also a tab id and so cannot use a colon."""

    @pytest.mark.parametrize(
        "text",
        [
            "workspace",
            "workspace@high_cost",
            "workspace@cold_fusion,high_cost",
            "run.3fa85f64-5717-4562-b3fc-2c963f66afa6",
        ],
    )
    def test_a_reference_round_trips(self, text):
        assert format_ref(parse_ref(text)) == text

    @pytest.mark.parametrize(
        "text", ["", "run.", "run", "commit.abc", "workspace.thing", "nonsense"]
    )
    def test_an_unreadable_reference_is_refused_rather_than_guessed(self, text):
        with pytest.raises(BadRef):
            parse_ref(text)

    def test_a_run_cannot_be_given_a_scenario_it_did_not_solve(self):
        """It solved what it solved; re-reading it otherwise would be fiction."""
        with pytest.raises(BadRef):
            parse_ref("run.abc@high_cost")

    def test_a_scenario_may_contain_a_comma(self):
        """Calliope's `scenario=` also takes a joined list of override names."""
        assert parse_ref("workspace@a,b").scenario == "a,b"

    def test_a_workspace_without_a_scenario_is_the_model_as_written(self):
        assert parse_ref("workspace") == Ref("workspace")


class TestFiles:
    def test_a_run_against_the_unchanged_model_reports_no_differences(
        self, client, ws, run_id
    ):
        """The property the view rests on: no edit, nothing claimed."""
        payload = compare(client, ws, f"run.{run_id}", "workspace").json()

        assert payload["identical"] is True
        assert set(statuses(payload).values()) == {"unchanged"}
        assert payload["a"]["kind"] == "run"
        assert payload["b"]["kind"] == "workspace"

    def test_an_edited_file_is_modified(self, client, ws, run_id, national_scale):
        target = national_scale / "model.yaml"
        target.write_text(
            target.read_text(encoding="utf-8") + "\n# edited\n", encoding="utf-8"
        )

        payload = compare(client, ws, f"run.{run_id}", "workspace").json()

        assert payload["identical"] is False
        assert statuses(payload)["model.yaml"] == "modified"

    def test_an_edit_that_keeps_the_length_is_still_seen(
        self, client, ws, run_id, national_scale
    ):
        """Compared by digest, not by size: the edit somebody makes to a number
        usually leaves the file exactly as long as it was."""
        target = national_scale / "model.yaml"
        text = target.read_text(encoding="utf-8")
        target.write_text(text.replace("National-scale", "Natlonal-scale"), "utf-8")

        payload = compare(client, ws, f"run.{run_id}", "workspace").json()
        assert statuses(payload)["model.yaml"] == "modified"

    def test_a_scratch_file_beside_the_model_is_not_reported(
        self, client, ws, run_id, national_scale
    ):
        """The workspace side is what the model *refers to*, not what is in the
        folder — otherwise every note and half-finished experiment beside a
        model reads as newly added."""
        (national_scale / "notes.md").write_text("scratch", encoding="utf-8")
        (national_scale / "unused.yaml").write_text("a: 1\n", encoding="utf-8")

        payload = compare(client, ws, f"run.{run_id}", "workspace").json()

        assert payload["identical"] is True
        assert "notes.md" not in statuses(payload)

    def test_a_deleted_file_is_removed_and_a_new_import_is_added(
        self, client, ws, national_scale
    ):
        before = make_run(national_scale)
        extra = national_scale / "extra.yaml"
        extra.write_text("techs: {}\n", encoding="utf-8")
        model = national_scale / "model.yaml"
        model.write_text(
            model.read_text(encoding="utf-8").replace(
                "import:", "import:\n  - extra.yaml", 1
            ),
            encoding="utf-8",
        )
        after = make_run(national_scale)

        payload = compare(client, ws, f"run.{before}", f"run.{after}").json()
        assert statuses(payload)["extra.yaml"] == "added"

        reversed_payload = compare(client, ws, f"run.{after}", f"run.{before}").json()
        assert statuses(reversed_payload)["extra.yaml"] == "removed"

    def test_the_entry_point_is_listed_first(self, client, ws, run_id):
        payload = compare(client, ws, f"run.{run_id}", "workspace").json()
        assert payload["files"][0]["path"] == "model.yaml"

    def test_two_scenarios_of_one_folder_read_the_same_files(self, client, ws):
        """So an empty file list there means the scenario, not a bug."""
        payload = compare(client, ws, "workspace", "workspace@cold_fusion").json()

        assert payload["identical"] is True
        assert payload["same_root"] is True


class TestFileContents:
    def test_both_sides_of_a_file_come_back(self, client, ws, run_id, national_scale):
        target = national_scale / "model.yaml"
        target.write_text(
            target.read_text(encoding="utf-8") + "\n# edited\n", encoding="utf-8"
        )

        payload = compare(
            client, ws, f"run.{run_id}", "workspace", "file", path="model.yaml"
        ).json()

        assert "# edited" not in payload["a"]["content"]
        assert "# edited" in payload["b"]["content"]
        assert payload["binary"] is False

    def test_a_file_one_side_does_not_have_is_null_rather_than_missing(
        self, client, ws, national_scale
    ):
        """An addition has to be renderable, and a diff editor wants two texts."""
        before = make_run(national_scale)
        (national_scale / "extra.yaml").write_text("techs: {}\n", encoding="utf-8")
        model = national_scale / "model.yaml"
        model.write_text(
            model.read_text(encoding="utf-8").replace(
                "import:", "import:\n  - extra.yaml", 1
            ),
            encoding="utf-8",
        )

        payload = compare(
            client, ws, f"run.{before}", "workspace", "file", path="extra.yaml"
        ).json()

        assert payload["a"] is None
        assert payload["b"]["content"] == "techs: {}\n"

    def test_a_binary_file_is_reported_rather_than_refused(
        self, client, ws, run_id, national_scale
    ):
        """One side being binary must not 415 the whole comparison: the view
        still has to say *that* the file differs, and which one it is."""
        target = national_scale / "model.yaml"
        target.write_bytes(b"\x00\x01\x02binary now")

        payload = compare(
            client, ws, f"run.{run_id}", "workspace", "file", path="model.yaml"
        ).json()

        assert payload["binary"] is True
        assert payload["a"] is None and payload["b"] is None

        listing = compare(client, ws, f"run.{run_id}", "workspace").json()
        assert statuses(listing)["model.yaml"] == "modified"
        assert listing["files"][0]["b"]["binary"] is True

    @pytest.mark.parametrize("attack", ["../../etc/passwd", "..%2f..%2fsecret"])
    def test_a_path_outside_a_side_is_refused(self, client, ws, run_id, attack):
        """Rejected as traversal, or simply absent — never served."""
        response = compare(
            client, ws, f"run.{run_id}", "workspace", "file", path=attack
        )
        assert response.status_code in (400, 404)

    def test_a_path_in_neither_version_is_a_404(self, client, ws, run_id):
        """Distinct from an addition, where one side legitimately has nothing."""
        response = compare(
            client, ws, f"run.{run_id}", "workspace", "file", path="nowhere.yaml"
        )
        assert response.status_code == 404


class TestRefusals:
    def test_a_malformed_reference_is_a_400(self, client, ws):
        assert compare(client, ws, "nonsense", "workspace").status_code == 400

    def test_an_unknown_run_is_a_404(self, client, ws):
        response = compare(client, ws, f"run.{uuid.uuid4()}", "workspace")
        assert response.status_code == 404

    def test_a_run_with_no_snapshot_says_so(self, client, ws, national_scale):
        """It cannot be compared, and the reason is not the user's fault."""
        run = make_run(national_scale, snapshot=False)
        response = compare(client, ws, f"run.{run}", "workspace")

        assert response.status_code == 400
        assert "nothing to compare" in response.json()["detail"]

    def test_a_run_belonging_to_another_model_is_not_found(
        self, client, ws, storage, urban_scale
    ):
        """Run ids are looked up across every registered model, so without this
        a comparison could reach into a model the URL does not name."""
        storage.open(urban_scale)
        foreign = make_run(urban_scale)

        response = compare(client, ws, f"run.{foreign}", "workspace")
        assert response.status_code == 404

    def test_a_scenario_the_model_does_not_define_is_reported_not_refused(
        self, client, ws
    ):
        """A scenario renamed since a run was solved is the state somebody
        comparing that run is in, and the files still compare perfectly well."""
        payload = compare(client, ws, "workspace", "workspace@no_such").json()

        assert payload["b"]["scenario_known"] is False
        assert payload["a"]["scenario_known"] is True
        assert payload["identical"] is True


class TestMeaning:
    def test_a_side_that_cannot_be_read_yet_answers_rather_than_failing(
        self, client, ws, run_id
    ):
        """Reading a model is a subprocess taking seconds. The client polls;
        it must not have to distinguish "not ready" from "went wrong"."""
        payload = compare(client, ws, f"run.{run_id}", "workspace", "model").json()

        assert payload["available"] in (True, False)
        assert set(payload) >= {"a", "b", "available", "pending"}
        if not payload["available"]:
            assert payload["pending"] or payload["reason"]

    def test_a_named_scenario_is_what_the_workspace_is_read_under(
        self, client, ws, national_scale, monkeypatch
    ):
        """Comparing a scenario run against the working tree is only about the
        files if the working tree is read under that same scenario — otherwise
        the diff is dominated by what the scenario does. The *caller* names it,
        which is why this is a property of the reference and not of the pair."""
        run = make_run(national_scale, scenario="cold_fusion")
        asked = self._record_resolves(monkeypatch)

        compare(client, ws, f"run.{run}", "workspace@cold_fusion", "model")

        assert dict(asked)[ws] == ("cold_fusion", {})

    def test_a_bare_workspace_reference_always_means_the_model_as_written(
        self, client, ws, national_scale, monkeypatch
    ):
        """Nothing is implicit. A scenario inferred from whatever it happened to
        be paired with would make one URL mean two things, and would leave the
        header's scenario picker with no current state to show."""
        run = make_run(national_scale, scenario="cold_fusion")
        asked = self._record_resolves(monkeypatch)

        compare(client, ws, f"run.{run}", "workspace", "model")

        assert dict(asked)[ws] == (None, {})

    @staticmethod
    def _record_resolves(monkeypatch) -> list:
        from calliope_studio.server.resolution import Resolver

        asked: list = []
        monkeypatch.setattr(
            Resolver,
            "get",
            lambda self, workspace, **kwargs: (
                asked.append((workspace.id, kwargs.get("variant"))) or _unresolved()
            ),
        )
        return asked

    def test_a_stale_reading_is_not_compared(self, client, ws, run_id, monkeypatch):
        """This is where a comparison parts company with the map.

        `/geo/` shows the last resolution that made sense while a rebuild runs,
        because a map of the previous save is more use than no map and a banner
        says so. A diff cannot be labelled that way — every number would need
        the caveat — and the case that matters is precisely the one it gets
        wrong: somebody has just edited something, the stale side still holds
        the old file, and the comparison reports no differences at all.
        """
        from calliope_studio.server.resolution import SOURCE_STALE, Resolution, Resolver

        monkeypatch.setattr(
            Resolver,
            "get",
            lambda self, workspace, **kwargs: Resolution(
                SOURCE_STALE, object(), task_id="task-1"
            ),
        )

        payload = compare(client, ws, f"run.{run_id}", "workspace", "model").json()

        assert payload["available"] is False
        # Still pending, not failed: a rebuild is running and the client should
        # ask again rather than report that the model cannot be read.
        assert payload["pending"] is True
        assert payload["b"]["model"]["source"] == "unavailable"
        assert payload["b"]["model"]["resolve_task"] == "task-1"

    def test_a_runs_frozen_tree_is_resolved_as_its_own_model(
        self, client, ws, national_scale, monkeypatch
    ):
        """A run that failed or was cancelled has no results, but its snapshot
        is an ordinary model folder — which is what makes it comparable at all."""
        run = make_run(national_scale)
        asked = []

        from calliope_studio.server.resolution import Resolver

        monkeypatch.setattr(
            Resolver,
            "get",
            lambda self, workspace, **kwargs: (
                asked.append(str(workspace.path)) or _unresolved()
            ),
        )

        compare(client, ws, f"run.{run}", "workspace", "model")

        assert any(path.endswith(protocol.SNAPSHOT_DIR) for path in asked)


def _unresolved():
    from calliope_studio.server.resolution import SOURCE_STRUCTURAL, Resolution

    return Resolution(SOURCE_STRUCTURAL, None, task_id="task-1")
