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
        runs = storage.runs_dir(workspace, create=True)
        assert runs.is_dir()
        assert runs.parent.parent == national_scale.resolve()

    def test_the_data_directory_is_visible(self, storage, national_scale):
        """Not hidden: results are the output, and a user must be able to find it."""
        workspace = storage.open(national_scale)
        assert storage.runs_dir(workspace).parent.name == "calligraph"

    def test_locating_runs_creates_nothing(self, storage, national_scale):
        """Opening a model and asking about its runs must leave no trace.

        The interface lists runs on load, and `runs_dir` used to create the
        directory as a side effect of being asked for it — so merely opening a
        model to look at it left a directory behind.
        """
        before = sorted(path.name for path in national_scale.iterdir())

        workspace = storage.open(national_scale)
        runs = storage.runs_dir(workspace)

        assert not runs.exists()
        assert not runs.parent.exists()
        assert sorted(path.name for path in national_scale.iterdir()) == before

    def test_first_real_run_writes_a_gitignore(self, storage, national_scale):
        """A model under version control must not sprout untracked files."""
        workspace = storage.open(national_scale)
        storage.runs_dir(workspace, create=True)
        marker = national_scale / "calligraph" / ".gitignore"
        assert marker.is_file()
        # Ignores itself, so nothing in here shows up in `git status` at all.
        assert "*" in marker.read_text()

    def test_validations_are_outside_the_workspace(self, storage, national_scale):
        """A validation leaves no artefact worth keeping, so it goes to a tempdir.

        Every Deep Validate click used to leave a permanent UUID-named directory
        beside the user's model, unreachable and unremovable from the interface.
        """
        storage.open(national_scale)
        validations = storage.validations_dir()
        assert validations.is_dir()
        assert national_scale.resolve() not in validations.resolve().parents

    def test_finished_validations_are_pruned(self, storage, national_scale):
        storage.open(national_scale)
        root = storage.validations_dir()
        for index in range(6):
            attempt = root / f"attempt-{index}"
            attempt.mkdir()
            (attempt / "outcome.json").write_text("{}")

        storage.prune_validations(keep=2)
        assert len(list(root.glob("*/"))) == 2

    def test_pruning_validations_spares_unfinished_attempts(
        self, storage, national_scale
    ):
        """A running validation is still being polled."""
        storage.open(national_scale)
        root = storage.validations_dir()
        (root / "running").mkdir()

        storage.prune_validations(keep=0)
        assert (root / "running").is_dir()


class TestRunRetention:
    def _finished_run(self, root, name):
        directory = root / name
        directory.mkdir(parents=True)
        (directory / "request.json").write_text("{}")
        (directory / "outcome.json").write_text('{"status": "success"}')
        return directory

    def test_oldest_finished_runs_are_removed(self, storage, national_scale):
        """A run now costs its results plus a frozen copy of the definition."""
        workspace = storage.open(national_scale)
        root = storage.runs_dir(workspace, create=True)
        for index in range(5):
            self._finished_run(root, f"run-{index}")

        removed = storage.prune_runs(workspace, keep=2)
        assert len(removed) == 3
        assert len(list(root.glob("*/"))) == 2

    def test_unfinished_runs_are_never_removed(self, storage, national_scale):
        workspace = storage.open(national_scale)
        root = storage.runs_dir(workspace, create=True)
        running = root / "still-going"
        running.mkdir()
        (running / "request.json").write_text("{}")

        assert storage.prune_runs(workspace, keep=0) == []
        assert running.is_dir()

    def test_pruning_a_workspace_with_no_runs_is_harmless(
        self, storage, national_scale
    ):
        workspace = storage.open(national_scale)
        assert storage.prune_runs(workspace) == []
        assert not (national_scale / "calligraph").exists()


class TestLegacyDataDirectory:
    def test_hidden_directory_is_migrated_on_open(self, storage, national_scale):
        """A workspace from before the rename keeps its run history at the new path."""
        legacy = national_scale / ".calligraph" / "runs" / "old-run"
        legacy.mkdir(parents=True)
        (legacy / "request.json").write_text("{}")

        storage.open(national_scale)

        assert not (national_scale / ".calligraph").exists()
        assert (national_scale / "calligraph" / "runs" / "old-run").is_dir()

    def test_migration_leaves_an_existing_visible_directory_alone(
        self, storage, national_scale
    ):
        """Two histories are never silently merged."""
        (national_scale / ".calligraph" / "runs").mkdir(parents=True)
        (national_scale / "calligraph" / "runs" / "current").mkdir(parents=True)

        storage.open(national_scale)

        assert (national_scale / ".calligraph").is_dir()
        assert (national_scale / "calligraph" / "runs" / "current").is_dir()
