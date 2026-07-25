"""FastAPI application factory.

`create_app()` builds the application; the module-level `app` exists so that
`uvicorn calligraph.server.app:app --reload` works during development, taking
its workspace from the `CALLIGRAPH_WORKSPACE` environment variable.
"""

import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

WORKSPACE_ENV_VAR = "CALLIGRAPH_WORKSPACE"

#: Where `pixi run web-build` puts the compiled Vue bundle. Absent in a source
#: checkout that has not built the frontend yet, in which case the API still
#: serves fine and the Vite dev server provides the UI.
STATIC_DIR = Path(__file__).parent / "static"


def create_app(workspace: Path | None = None) -> FastAPI:
    """Builds the application.

    Args:
        workspace: Model definition folder or solved `.nc` file to open on
            start. Falls back to `$CALLIGRAPH_WORKSPACE`, then the working
            directory.

    Returns:
        The configured FastAPI application.
    """
    if workspace is None:
        env_value = os.environ.get(WORKSPACE_ENV_VAR)
        workspace = Path(env_value) if env_value else Path.cwd()

    app = FastAPI(title="Calligraph", version=_version())
    app.state.workspace = workspace.resolve()

    @app.get("/api/health")
    def health() -> dict:
        return {"status": "ok", "workspace": str(app.state.workspace)}

    _mount_frontend(app)
    return app


def _mount_frontend(app: FastAPI) -> None:
    """Serves the built Vue bundle, if one has been built into the package.

    Unknown paths fall back to `index.html` so that client-side routing works on
    a hard refresh; anything under `/api` is left alone.
    """
    if not STATIC_DIR.is_dir():
        return

    index = STATIC_DIR / "index.html"
    app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str) -> FileResponse:
        candidate = STATIC_DIR / path
        if path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(index)


def _version() -> str:
    from calligraph import __version__

    return __version__


app = create_app()
