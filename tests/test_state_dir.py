"""The state-directory override.

Without this, code paths that build their own `LocalStorage` — the CLI, the
module-level app — write into the developer's real state directory, and a test
run leaves behind entries pointing at temporary folders.
"""

from pathlib import Path

import platformdirs

from calligraph.server.storage import (
    STATE_DIR_ENV_VAR,
    LocalStorage,
    default_registry_path,
)


class TestStateDirOverride:
    def test_override_is_honoured(self, tmp_path, monkeypatch):
        monkeypatch.setenv(STATE_DIR_ENV_VAR, str(tmp_path / "elsewhere"))
        assert default_registry_path() == tmp_path / "elsewhere" / "workspaces.json"

    def test_default_is_the_platform_state_dir(self, monkeypatch):
        monkeypatch.delenv(STATE_DIR_ENV_VAR, raising=False)
        expected = Path(platformdirs.user_state_dir("calligraph")) / "workspaces.json"
        assert default_registry_path() == expected

    def test_read_per_call_not_at_import(self, tmp_path, monkeypatch):
        """A fixture setting the variable must affect later construction."""
        monkeypatch.setenv(STATE_DIR_ENV_VAR, str(tmp_path / "first"))
        assert LocalStorage().registry_path.parent == tmp_path / "first"
        monkeypatch.setenv(STATE_DIR_ENV_VAR, str(tmp_path / "second"))
        assert LocalStorage().registry_path.parent == tmp_path / "second"

    def test_the_suite_never_writes_to_the_real_registry(self, national_scale):
        """The autouse fixture in conftest must cover default construction."""
        real = Path(platformdirs.user_state_dir("calligraph")) / "workspaces.json"
        storage = LocalStorage()
        assert storage.registry_path != real
        storage.open(national_scale)
        assert storage.registry_path.is_file()
