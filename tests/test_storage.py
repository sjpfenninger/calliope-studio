"""The workspace registry.

There is no database, so the registry file is the only persistent state the
server owns. It is also the thing most likely to be found corrupt, stale or
half-written, and none of those may take the app down.
"""

import json

import pytest

from calliope_studio.server.storage import LocalStorage, WorkspaceNotFound, workspace_id


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

    def test_missing_folders_are_left_out_but_remembered(
        self, storage, national_scale, urban_scale, tmp_path
    ):
        """A folder that is not there is not listed, and is not forgotten.

        `list()` runs on nearly every request, and a folder can be absent because
        the drive holding it is not mounted right now. This used to *persist* the
        prune, so one launch without the drive erased the model from the recents
        list for good. Now the entry waits, and comes back when the folder does.
        """
        storage.open(national_scale)
        gone = tmp_path / "gone"
        gone.mkdir()
        storage.open(gone)
        gone.rmdir()

        assert [w.name for w in storage.list()] == ["national_scale"]
        assert len(json.loads(storage.registry_path.read_text())) == 2

        gone.mkdir()
        assert [w.name for w in storage.list()] == ["gone", "national_scale"]

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
        assert storage.runs_dir(workspace).parent.name == "calliope-studio"

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
        marker = national_scale / "calliope-studio" / ".gitignore"
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
        assert not (national_scale / "calliope-studio").exists()


class TestRetentionSetting:
    """How many runs to keep is a per-workspace preference, not a constant.

    A national model at 100 MB a run and a teaching model at 500 kB want wildly
    different limits, and the value is about the machine's disk rather than the
    model, which is why it lives in the registry.
    """

    def test_a_new_workspace_gets_the_default(self, storage, national_scale):
        assert storage.open(national_scale).run_retention == 20

    def test_the_setting_persists(self, storage, national_scale, tmp_path):
        from calliope_studio.server.storage import LocalStorage

        workspace = storage.open(national_scale)
        storage.set_run_retention(workspace, 3)

        # A fresh storage reads it back from the registry, as a restart would.
        reopened = LocalStorage(storage.registry_path).get(workspace.id)
        assert reopened.run_retention == 3

    def test_reopening_a_model_does_not_reset_it(self, storage, national_scale):
        """`open` rewrites the entry to move it to the top of the recents list.

        Anything not carried across is silently lost every time the model is
        opened, which for a setting means it never appears to stick.
        """
        storage.set_run_retention(storage.open(national_scale), 5)
        assert storage.open(national_scale).run_retention == 5

    def test_keeping_everything_is_expressible(self, storage, national_scale):
        workspace = storage.set_run_retention(storage.open(national_scale), None)
        assert workspace.run_retention is None

    def test_zero_is_refused(self, storage, national_scale):
        # Keeping zero runs would delete the history on the next run, which no
        # one means; "keep everything" is null, not 0.
        workspace = storage.set_run_retention(storage.open(national_scale), 0)
        assert workspace.run_retention == 1

    def test_a_registry_written_before_the_setting_existed_still_opens(
        self, storage, national_scale
    ):
        import json

        workspace = storage.open(national_scale)
        entries = json.loads(storage.registry_path.read_text())
        for entry in entries:
            entry.pop("run_retention", None)
        storage.registry_path.write_text(json.dumps(entries))

        assert storage.get(workspace.id).run_retention == 20

    def test_a_hand_edited_nonsense_value_falls_back(self, storage, national_scale):
        import json

        workspace = storage.open(national_scale)
        entries = json.loads(storage.registry_path.read_text())
        entries[0]["run_retention"] = "lots"
        storage.registry_path.write_text(json.dumps(entries))

        assert storage.get(workspace.id).run_retention == 20


class TestLegacyDataDirectory:
    @pytest.mark.parametrize("legacy_name", [".calligraph", "calligraph"])
    def test_an_earlier_directory_is_migrated_on_open(
        self, storage, national_scale, legacy_name
    ):
        """A workspace from before the rename keeps its run history.

        Both earlier names: `.calligraph` is the older, hidden one; `calligraph` is
        the visible directory this project used before it was renamed.
        """
        legacy = national_scale / legacy_name / "runs" / "old-run"
        legacy.mkdir(parents=True)
        (legacy / "request.json").write_text("{}")

        storage.open(national_scale)

        assert not (national_scale / legacy_name).exists()
        assert (national_scale / "calliope-studio" / "runs" / "old-run").is_dir()

    def test_migration_leaves_an_existing_current_directory_alone(
        self, storage, national_scale
    ):
        """Two histories are never silently merged."""
        (national_scale / ".calligraph" / "runs").mkdir(parents=True)
        (national_scale / "calliope-studio" / "runs" / "current").mkdir(parents=True)

        storage.open(national_scale)

        assert (national_scale / ".calligraph").is_dir()
        assert (national_scale / "calliope-studio" / "runs" / "current").is_dir()

    def test_the_newest_earlier_name_wins(self, storage, national_scale):
        """A workspace carrying both earlier names promotes only one.

        `calligraph/` was authoritative over `.calligraph/` under the old rules —
        that is what the earlier migration decided — so it stays authoritative
        here. The other is left where it is rather than merged, and
        `EXCLUDED_NAMES` keeps hiding it.
        """
        (national_scale / ".calligraph" / "runs" / "hidden-era").mkdir(parents=True)
        (national_scale / "calligraph" / "runs" / "visible-era").mkdir(parents=True)

        storage.open(national_scale)

        assert (national_scale / "calliope-studio" / "runs" / "visible-era").is_dir()
        assert (national_scale / ".calligraph" / "runs" / "hidden-era").is_dir()
        assert not (national_scale / "calligraph").exists()


class TestRetentionOrder:
    def _finished_run(self, root, name, requested_at):
        directory = root / name
        directory.mkdir(parents=True)
        (directory / "request.json").write_text(
            json.dumps({"workspace": "w", "requested_at": requested_at})
        )
        (directory / "outcome.json").write_text('{"status": "success"}')
        return directory

    def test_runs_are_ordered_by_when_they_were_requested(
        self, storage, national_scale
    ):
        """Never by directory mtime, which a copy of the workspace reshuffles.

        Retention ordered by mtime deleted the *newest* results of a model that
        had just been copied to another machine, and kept the oldest.
        """
        import os
        import time

        workspace = storage.open(national_scale)
        root = storage.runs_dir(workspace, create=True)
        for index, day in enumerate(["03", "01", "02"]):
            self._finished_run(root, f"run-{index}", f"2026-01-{day}T00:00:00+00:00")
        # The mtimes say the opposite: the newest request is the oldest directory.
        now = time.time()
        for index, age in enumerate([300, 200, 100]):
            os.utime(root / f"run-{index}", (now - age, now - age))

        assert storage.prune_runs(workspace, keep=2) == ["run-1"]

    def test_a_run_made_before_the_timestamp_existed_still_orders(
        self, storage, national_scale
    ):
        workspace = storage.open(national_scale)
        root = storage.runs_dir(workspace, create=True)
        old = root / "old"
        old.mkdir()
        (old / "request.json").write_text("{}")
        (old / "outcome.json").write_text('{"status": "success"}')
        self._finished_run(root, "new", "2030-01-01T00:00:00+00:00")

        assert storage.prune_runs(workspace, keep=1) == ["old"]


class TestRegistryEntriesSurviveReopening:
    def test_a_field_this_version_does_not_know_is_kept(self, storage, national_scale):
        """`open()` rewrites the entry to move it up the list; it must not shrink it."""
        storage.open(national_scale)
        entries = json.loads(storage.registry_path.read_text())
        entries[0]["colour"] = "red"
        storage.registry_path.write_text(json.dumps(entries))

        storage.open(national_scale)
        assert json.loads(storage.registry_path.read_text())[0]["colour"] == "red"


class TestLegacyDirectoryMarker:
    def test_a_folder_that_merely_shares_the_name_is_left_alone(
        self, storage, national_scale
    ):
        """`calligraph` is also this project's predecessor's name.

        A user who kept its plotting scripts beside their model had the folder
        renamed on open, hidden from the file tree and reported by git as moved.
        Only a directory holding run outputs is migrated.
        """
        scripts = national_scale / "calligraph"
        scripts.mkdir()
        (scripts / "plots.py").write_text("print('hi')\n")

        storage.open(national_scale)

        assert (scripts / "plots.py").is_file()
        assert not (national_scale / "calliope-studio").exists()
