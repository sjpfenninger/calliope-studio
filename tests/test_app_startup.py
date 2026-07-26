"""How the application picks up its workspace when started for real.

The test client always constructs the app directly, so it cannot catch mistakes
in the path the CLI actually takes: environment variable, import string,
uvicorn. These tests exercise that path instead.
"""

import importlib
from types import SimpleNamespace

import click
import pytest
from fastapi.testclient import TestClient

import calligraph.cli as cli_module
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


@pytest.fixture
def served(monkeypatch):
    """Captures what the CLI would serve, without serving it."""
    import calligraph.cli as cli

    recorded: dict = {}

    class FakeServer:
        def __init__(self, config):
            recorded["target"] = config.app

        def run(self, sockets=None):
            recorded["sockets"] = sockets
            # Resolve the app the way uvicorn does, at serve time.
            module_name, _, attribute = recorded["target"].partition(":")
            module = importlib.import_module(module_name)
            importlib.reload(module)
            recorded["workspace"] = getattr(module, attribute).state.workspace

    monkeypatch.setattr("uvicorn.Server", FakeServer)
    monkeypatch.setattr(
        "uvicorn.Config", lambda app, **kwargs: SimpleNamespace(app=app)
    )
    monkeypatch.setattr("uvicorn.run", lambda *a, **k: recorded.update(reload_args=k))
    monkeypatch.setattr(cli, "open_browser", lambda url: recorded.update(url=url))
    return cli, recorded


class TestCli:
    """The path the CLI actually takes, which the test client cannot reach."""

    def test_the_workspace_is_published_before_the_app_resolves(
        self, served, national_scale
    ):
        cli, recorded = served
        cli.main(
            [str(national_scale), "--no-browser", "--port", "0"], standalone_mode=False
        )
        assert recorded["workspace"] == national_scale.resolve()

    def test_the_bound_socket_is_handed_to_the_server(self, served, national_scale):
        cli, recorded = served
        cli.main(
            [str(national_scale), "--no-browser", "--port", "0"], standalone_mode=False
        )
        # Binding in the CLI is what makes the port knowable before serving.
        assert recorded["sockets"] and len(recorded["sockets"]) == 1

    def test_the_browser_is_sent_to_the_port_actually_bound(
        self, served, national_scale
    ):
        """`--port 0` used to open http://127.0.0.1:0/, a dead tab."""
        cli, recorded = served
        cli.main([str(national_scale), "--port", "0"], standalone_mode=False)

        opened = recorded["url"]
        assert opened.startswith("http://127.0.0.1:")
        port = int(opened.rstrip("/").rsplit(":", 1)[1])
        assert port > 0
        assert port == recorded["sockets"][0].getsockname()[1]

    def test_reload_releases_the_socket(self, served, national_scale):
        """The reloader binds its own; ours would keep the port occupied."""
        cli, recorded = served
        cli.main(
            [str(national_scale), "--no-browser", "--reload", "--port", "0"],
            standalone_mode=False,
        )
        assert "reload_args" in recorded
        assert recorded["reload_args"]["reload"] is True


class TestPortSelection:
    def test_a_free_port_is_returned(self):
        listener = cli_module.bind_available("127.0.0.1", 0)
        try:
            assert listener.getsockname()[1] > 0
        finally:
            listener.close()

    def test_a_busy_port_falls_through_to_the_next(self):
        """Opening a second model must not fail with "address already in use"."""
        first = cli_module.bind_available("127.0.0.1", 0)
        try:
            taken = first.getsockname()[1]
            second = cli_module.bind_available("127.0.0.1", taken)
            try:
                assert second.getsockname()[1] != taken
                assert second.getsockname()[1] > taken
            finally:
                second.close()
        finally:
            first.close()

    def test_giving_up_is_an_error_the_user_can_read(self, monkeypatch):
        held = [cli_module.bind_available("127.0.0.1", 0)]
        try:
            start = held[0].getsockname()[1]
            for offset in range(1, 4):
                try:
                    held.append(cli_module.bind_available("127.0.0.1", start + offset))
                except click.ClickException:
                    pass
            with pytest.raises(click.ClickException, match="No free port"):
                cli_module.bind_available("127.0.0.1", start, attempts=1)
        finally:
            for listener in held:
                listener.close()


class TestTargetValidation:
    """What `calligraph <path>` accepts, and where it lands."""

    def test_a_model_folder_opens_the_editor(self, national_scale):
        assert cli_module.describe_target(national_scale) == "/"

    def test_a_results_file_goes_straight_to_the_charts(self, solved_results):
        # Opening a solved model can only mean one thing.
        assert cli_module.describe_target(solved_results) == "/results"

    def test_a_folder_without_a_model_is_rejected(self, tmp_path):
        """This used to serve an empty file tree, which reads as a broken app."""
        empty = tmp_path / "not-a-model"
        empty.mkdir()
        with pytest.raises(click.ClickException) as failure:
            cli_module.describe_target(empty)
        message = str(failure.value)
        assert "No model.yaml" in message
        assert "calliope new" in message, "the error should say how to proceed"

    def test_an_unrelated_file_is_rejected(self, national_scale):
        with pytest.raises(click.ClickException, match="not a Calliope results file"):
            cli_module.describe_target(national_scale / "model.yaml")

    def test_the_cli_refuses_before_binding_a_port(self, tmp_path, monkeypatch):
        """Nothing should be started for a path that cannot be opened."""
        import calligraph.cli as cli

        empty = tmp_path / "empty"
        empty.mkdir()
        monkeypatch.setattr(
            cli, "bind_available", lambda *a, **k: pytest.fail("bound a port anyway")
        )
        with pytest.raises(click.ClickException):
            cli.main([str(empty), "--no-browser"], standalone_mode=False)

    def test_a_results_file_opens_the_browser_at_the_results_view(
        self, served, solved_results
    ):
        cli, recorded = served
        cli.main([str(solved_results), "--port", "0"], standalone_mode=False)
        assert recorded["url"].endswith("/results")
