"""How the application picks up its workspace when started for real.

The test client always constructs the app directly, so it cannot catch mistakes
in the path the CLI actually takes: environment variable, import string,
uvicorn. These tests exercise that path instead.
"""

import importlib

from fastapi.testclient import TestClient

from calligraph.server import app as app_module
from calligraph.server.app import WORKSPACE_ENV_VAR, create_app


class TestWorkspaceResolution:
    def test_explicit_argument_wins(self, national_scale, storage):
        app = create_app(workspace=national_scale, storage=storage)
        assert app.state.workspace == national_scale.resolve()

    def test_falls_back_to_the_environment(self, national_scale, storage, monkeypatch):
        monkeypatch.setenv(WORKSPACE_ENV_VAR, str(national_scale))
        app = create_app(storage=storage)
        assert app.state.workspace == national_scale.resolve()

    def test_module_level_app_is_built_lazily(self, national_scale, monkeypatch):
        """Regression: the app must not be built at import time.

        `cli.py` imports this module for a constant before setting the
        environment variable. When `app` was a module-level call, that import
        captured the working directory and every run served the wrong folder.
        """
        importlib.reload(app_module)
        monkeypatch.setenv(WORKSPACE_ENV_VAR, str(national_scale))
        assert app_module.app.state.workspace == national_scale.resolve()

    def test_opening_a_model_folder_registers_it(self, national_scale, storage):
        create_app(workspace=national_scale, storage=storage)
        assert [w.name for w in storage.list()] == ["national_scale"]

    def test_a_non_model_directory_is_not_registered(self, tmp_path, storage):
        """Starting the server in the wrong place must not create a project.

        The dev server used to default to the working directory, so merely
        running it added this repository to the user's project list.
        """
        somewhere = tmp_path / "not-a-model"
        somewhere.mkdir()
        app = create_app(workspace=somewhere, storage=storage)
        assert app.state.active_workspace is None
        assert storage.list() == []

    def test_a_non_directory_workspace_does_not_crash_startup(
        self, national_scale, storage
    ):
        # `calligraph results.nc` is a legitimate entry point; there is simply
        # no model folder to register.
        app = create_app(workspace=national_scale / "model.yaml", storage=storage)
        assert app.state.active_workspace is None
        with TestClient(app) as client:
            assert client.get("/api/health").json()["workspace_id"] is None


class TestCli:
    def test_cli_sets_the_environment_before_serving(self, national_scale, monkeypatch):
        """The CLI must publish the workspace before uvicorn resolves the app."""
        import calligraph.cli as cli

        recorded = {}

        def fake_run(target, **kwargs):
            # Resolve the app the same way uvicorn does, at serve time.
            module_name, _, attribute = target.partition(":")
            module = importlib.import_module(module_name)
            importlib.reload(module)
            recorded["workspace"] = getattr(module, attribute).state.workspace

        monkeypatch.setattr("uvicorn.run", fake_run)
        monkeypatch.setattr(cli, "_open_browser_when_ready", lambda *a, **k: None)

        cli.main(
            [str(national_scale), "--no-browser", "--port", "0"], standalone_mode=False
        )
        assert recorded["workspace"] == national_scale.resolve()
