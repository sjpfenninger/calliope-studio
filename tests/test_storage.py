"""The workspace registry.

There is no database, so the registry file is the only persistent state the
server owns. It is also the thing most likely to be found corrupt, stale or
half-written, and none of those may take the app down.
"""

import json

import pytest

from calligraph.server.storage import LocalStorage, WorkspaceNotFound, workspace_id


class TestWorkspaceId:
    def test_is_stable_across_instances(self, tmp_path):
        assert workspace_id(tmp_path) == workspace_id(tmp_path)

    def test_ignores_path_spelling(self, tmp_path):
        # Derived from the resolved path, so a bookmarked URL keeps working
        # however the folder was named on the way in.
        (tmp_path / "sub").mkdir()
        assert workspace_id(tmp_path / "sub") == workspace_id(
            tmp_path / "sub" / "." / ".." / "sub"
        )

    def test_differs_between_folders(self, tmp_path):
        (tmp_path / "a").mkdir()
        (tmp_path / "b").mkdir()
        assert workspace_id(tmp_path / "a") != workspace_id(tmp_path / "b")


class TestRegistry:
    def test_opening_registers_and_returns(self, storage, national_scale):
        workspace = storage.open(national_scale)
        assert workspace.name == "national_scale"
        assert storage.get(workspace.id).path == national_scale.resolve()

    def test_reopening_does_not_duplicate(self, storage, national_scale):
        storage.open(national_scale)
        storage.open(national_scale)
        assert len(storage.list()) == 1

    def test_most_recently_opened_comes_first(
        self, storage, national_scale, urban_scale
    ):
        storage.open(national_scale)
        storage.open(urban_scale)
        assert [w.name for w in storage.list()] == ["urban_scale", "national_scale"]

    def test_unknown_id_raises(self, storage):
        with pytest.raises(WorkspaceNotFound):
            storage.get("nope")

    def test_opening_a_file_is_rejected(self, storage, national_scale):
        with pytest.raises(NotADirectoryError):
            storage.open(national_scale / "model.yaml")

    def test_deleted_folders_are_pruned_not_raised(
        self, storage, national_scale, urban_scale, tmp_path
    ):
        storage.open(national_scale)
        gone = tmp_path / "gone"
        gone.mkdir()
        storage.open(gone)
        gone.rmdir()

        assert [w.name for w in storage.list()] == ["national_scale"]
        # The prune is persisted, not merely filtered on read.
        assert len(json.loads(storage.registry_path.read_text())) == 1

    def test_corrupt_registry_is_survivable(self, storage, national_scale):
        storage.registry_path.parent.mkdir(parents=True, exist_ok=True)
        storage.registry_path.write_text("{not json at all")
        assert storage.list() == []
        # And can still be recovered by opening something.
        assert storage.open(national_scale).name == "national_scale"

    def test_missing_registry_is_not_an_error(self, tmp_path):
        assert LocalStorage(registry_path=tmp_path / "nope.json").list() == []

    def test_malformed_entries_are_skipped(self, storage, national_scale):
        storage.open(national_scale)
        entries = json.loads(storage.registry_path.read_text())
        entries.append({"path": str(national_scale), "opened_at": "not-a-date"})
        entries.append({"no_path": True})
        storage.registry_path.write_text(json.dumps(entries))
        assert [w.name for w in storage.list()] == ["national_scale"]


class TestRunDirectories:
    def test_runs_live_beside_the_model(self, storage, national_scale):
        workspace = storage.open(national_scale)
        runs = storage.runs_dir(workspace)
        assert runs.is_dir()
        assert runs.parent.parent == national_scale.resolve()

    def test_validations_are_kept_apart_from_runs(self, storage, national_scale):
        workspace = storage.open(national_scale)
        assert storage.validations_dir(workspace) != storage.runs_dir(workspace)
