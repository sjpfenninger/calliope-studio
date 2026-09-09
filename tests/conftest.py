"""Shared fixtures.

Model fixtures are copies of Calliope's own bundled example models, so they stay
current with whatever Calliope version is installed rather than drifting as a
private snapshot would.
"""

import inspect
import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from calliope_studio.server.app import create_app
from calliope_studio.server.storage import STATE_DIR_ENV_VAR, LocalStorage


@pytest.fixture(autouse=True)
def isolated_state_dir(tmp_path, monkeypatch):
    """Keeps every test out of the developer's real state directory.

    Not every code path takes an injected `LocalStorage` — the CLI and the
    module-level app both construct their own — so redirecting the whole state
    directory is the only reliable way to stop tests registering temporary
    folders as the user's real projects.
    """
    monkeypatch.setenv(STATE_DIR_ENV_VAR, str(tmp_path / "state"))


def _example_models_dir() -> Path:
    import calliope

    return Path(inspect.getfile(calliope)).parent / "example_models"


@pytest.fixture
def national_scale(tmp_path: Path) -> Path:
    """A writable copy of Calliope's national_scale example model."""
    destination = tmp_path / "national_scale"
    shutil.copytree(_example_models_dir() / "national_scale", destination)
    return destination


@pytest.fixture
def urban_scale(tmp_path: Path) -> Path:
    """A writable copy of Calliope's urban_scale example model."""
    destination = tmp_path / "urban_scale"
    shutil.copytree(_example_models_dir() / "urban_scale", destination)
    return destination


@pytest.fixture(scope="session")
def solved_results(tmp_path_factory) -> Path:
    """A solved national_scale model, as a `results.nc`.

    Session-scoped: solving takes several seconds and every results test wants
    the same model, so it is solved once.
    """
    import calliope

    directory = tmp_path_factory.mktemp("solved")
    model_dir = directory / "national_scale"
    shutil.copytree(_example_models_dir() / "national_scale", model_dir)

    model = calliope.read_yaml(str(model_dir / "model.yaml"))
    model.build()
    model.solve()

    output = directory / "results.nc"
    model.to_netcdf(str(output))
    return output


@pytest.fixture
def results(solved_results: Path):
    """A loaded results handle for the solved model."""
    from calliope_studio.results.store import ResultStore

    store = ResultStore()
    return store.get(store.register(solved_results))


@pytest.fixture
def storage(tmp_path: Path) -> LocalStorage:
    """Storage backed by a registry inside the test's temporary directory."""
    return LocalStorage(registry_path=tmp_path / "registry" / "workspaces.json")


@pytest.fixture
def client(national_scale: Path, storage: LocalStorage) -> TestClient:
    """A test client with the national_scale model open as its workspace."""
    app = create_app(workspace=national_scale, storage=storage)
    with TestClient(app) as test_client:
        test_client.workspace_id = storage.open(national_scale).id
        yield test_client


@pytest.fixture(autouse=True)
def forget_rendered_math():
    """Clears `routes.math._RENDERED` around every test.

    It is a module-level dict keyed by workspace id, which is a hash of the
    workspace *path* — so it survives a fresh `create_app` over the same folder,
    and a test that "restarts" the server to prove a rendering is answered from
    disk would be answered from memory instead, silently proving nothing.
    """
    from calliope_studio.server.routes import math as math_route

    math_route._RENDERED.clear()
    yield
    math_route._RENDERED.clear()


#: A committer for the tests that shell out to git. See `hermetic_git`.
GIT_IDENTITY = "[user]\n\tname = Studio Test\n\temail = studio@example.com\n"


@pytest.fixture
def hermetic_git(tmp_path: Path, monkeypatch) -> Path:
    """Git reads only what the test wrote, and knows who is committing.

    The suite's git-shelling tests point `GIT_CONFIG_GLOBAL` and
    `GIT_CONFIG_SYSTEM` at files of their own, so an inherited
    `commit.gpgsign = true` with a broken helper — the hazard the retry in
    `vcs/commit.py` exists for — cannot fail the suite on one machine only, and
    the identity every commit needs is written here rather than assumed of the
    CI runner, which has none.

    Returns the global config file, so a test can rewrite it.
    """
    global_config = tmp_path / "gitconfig"
    global_config.write_text(GIT_IDENTITY, encoding="utf-8")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(global_config))
    monkeypatch.setenv("GIT_CONFIG_SYSTEM", str(tmp_path / "no-system-config"))
    # A hook or template directory from the developer's setup must not reach a
    # repository the test creates.
    monkeypatch.delenv("GIT_DIR", raising=False)
    monkeypatch.delenv("GIT_WORK_TREE", raising=False)
    return global_config
