"""The state-directory override.

Without this, code paths that build their own `LocalStorage` — the CLI, the
module-level app — write into the developer's real state directory, and a test
run leaves behind entries pointing at temporary folders.
"""

from pathlib import Path

import platformdirs

from calliope_studio.server.storage import (
    REGISTRY_FILENAME,
    STATE_DIR_ENV_VAR,
    STATE_DIR_NAME,
    LocalStorage,
    carry_over_registry,
    default_registry_path,
    legacy_registry_paths,
)


class TestStateDirOverride:
    def test_override_is_honoured(self, tmp_path, monkeypatch):
        monkeypatch.setenv(STATE_DIR_ENV_VAR, str(tmp_path / "elsewhere"))
        assert default_registry_path() == tmp_path / "elsewhere" / "workspaces.json"

    def test_default_is_the_platform_state_dir(self, monkeypatch):
        monkeypatch.delenv(STATE_DIR_ENV_VAR, raising=False)
        expected = Path(platformdirs.user_state_dir(STATE_DIR_NAME)) / REGISTRY_FILENAME
        assert default_registry_path() == expected

    def test_read_per_call_not_at_import(self, tmp_path, monkeypatch):
        """A fixture setting the variable must affect later construction."""
        monkeypatch.setenv(STATE_DIR_ENV_VAR, str(tmp_path / "first"))
        assert LocalStorage().registry_path.parent == tmp_path / "first"
        monkeypatch.setenv(STATE_DIR_ENV_VAR, str(tmp_path / "second"))
        assert LocalStorage().registry_path.parent == tmp_path / "second"

    def test_the_suite_never_writes_to_the_real_registry(self, national_scale):
        """The autouse fixture in conftest must cover default construction."""
        real = Path(platformdirs.user_state_dir(STATE_DIR_NAME)) / REGISTRY_FILENAME
        storage = LocalStorage()
        assert storage.registry_path != real
        storage.open(national_scale)
        assert storage.registry_path.is_file()


class TestRegistryCarryOver:
    """Renaming the project moves the directory `platformdirs` hands out.

    Without carrying the registry across, the first launch under the new name
    looks like a fresh install and the user's whole recents list is gone.
    """

    def test_a_fresh_state_dir_is_seeded_from_the_earlier_one(self, tmp_path):
        legacy = tmp_path / "old" / REGISTRY_FILENAME
        legacy.parent.mkdir(parents=True)
        legacy.write_text('[{"id": "abc"}]')
        registry = tmp_path / "new" / REGISTRY_FILENAME

        assert carry_over_registry(registry, [legacy]) is True
        assert registry.read_text() == '[{"id": "abc"}]'

    def test_the_earlier_one_is_copied_not_moved(self, tmp_path):
        """An installation under the old name has to keep working."""
        legacy = tmp_path / "old" / REGISTRY_FILENAME
        legacy.parent.mkdir(parents=True)
        legacy.write_text("[]")

        carry_over_registry(tmp_path / "new" / REGISTRY_FILENAME, [legacy])

        assert legacy.is_file()

    def test_an_existing_registry_is_never_overwritten(self, tmp_path):
        legacy = tmp_path / "old" / REGISTRY_FILENAME
        legacy.parent.mkdir(parents=True)
        legacy.write_text('[{"id": "old"}]')
        registry = tmp_path / "new" / REGISTRY_FILENAME
        registry.parent.mkdir(parents=True)
        registry.write_text('[{"id": "current"}]')

        assert carry_over_registry(registry, [legacy]) is False
        assert registry.read_text() == '[{"id": "current"}]'

    def test_nothing_to_carry_over_is_not_an_error(self, tmp_path):
        registry = tmp_path / "new" / REGISTRY_FILENAME
        assert carry_over_registry(registry, [tmp_path / "absent.json"]) is False
        assert not registry.exists()

    def test_an_explicit_state_dir_is_never_seeded(self, tmp_path, monkeypatch):
        """`$CALLIOPE_STUDIO_STATE_DIR` says where the registry is, full stop.

        This is also what keeps the suite — which sets it for every test — from
        touching the developer's real state directory.
        """
        monkeypatch.setenv(STATE_DIR_ENV_VAR, str(tmp_path / "explicit"))
        assert LocalStorage().registry_path.exists() is False

    def test_legacy_paths_are_newest_first(self):
        """The order the carry-over consumes them in, so it matters."""
        names = [path.parent.name for path in legacy_registry_paths()]
        assert names == ["calligraph"]
