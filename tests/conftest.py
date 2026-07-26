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

from calligraph.server.app import create_app
from calligraph.server.storage import STATE_DIR_ENV_VAR, LocalStorage


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
