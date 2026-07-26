"""FastAPI application factory.

`create_app()` builds the application; the module-level `app` exists so that
`uvicorn calligraph.server.app:app --reload` works during development, taking
its workspace from the `CALLIGRAPH_WORKSPACE` environment variable.
"""

import os
from pathlib import Path

from fastapi import FastAPI, HTTPException, status
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from calligraph.results.store import ResultStore
from calligraph.runs import protocol
from calligraph.runs.manager import RunManager
from calligraph.server.mode import NotSomethingToOpen, resolve_target
from calligraph.server.routes import api_router
from calligraph.server.storage import LocalStorage

WORKSPACE_ENV_VAR = "CALLIGRAPH_WORKSPACE"

#: Where `pixi run web-build` puts the compiled Vue bundle. Absent in a source
#: checkout that has not built the frontend yet, in which case the API still
#: serves fine and the Vite dev server provides the UI.
STATIC_DIR = Path(__file__).parent / "static"


def create_app(
    workspace: Path | None = None, storage: LocalStorage | None = None
) -> FastAPI:
    """Builds the application.

    Args:
        workspace: Model definition folder or solved `.nc` file to open on
            start. Falls back to `$CALLIGRAPH_WORKSPACE`, then the working
            directory.
        storage: Storage backend. Defaults to the local folder registry; tests
            pass one pointed at a temporary directory.

    Returns:
        The configured FastAPI application.
    """
    if workspace is None:
        env_value = os.environ.get(WORKSPACE_ENV_VAR)
        workspace = Path(env_value) if env_value else Path.cwd()

    app = FastAPI(title="Calligraph", version=_version())
    app.state.workspace = workspace.resolve()
    app.state.storage = storage or LocalStorage()
    # The manager is given a way to *find* a run it did not start, rather than a
    # dependency on storage: `runs` knows nothing about workspaces. Ordering
    # matters — storage has to exist before the closure is first called.
    app.state.runs = RunManager(search_roots=lambda: app.state.storage.run_roots())
    # Likewise the store is given a way to resolve a handle it never minted, so
    # that a bookmarked results URL survives a restart.
    app.state.results = ResultStore(candidates=lambda: _results_candidates(app.state))

    # The same classification the CLI used to choose its landing URL, so the two
    # cannot disagree about what is open. An unopenable path is not fatal here —
    # the CLI has already rejected it, and `uvicorn ...app:app` in a random
    # directory should still serve the API.
    try:
        target = resolve_target(app.state.workspace)
    except NotSomethingToOpen:
        target = None
    app.state.target = target

    # `calligraph results.nc` opens a solved model directly, with no model
    # definition to edit. The analysis half has to work on its own.
    app.state.active_results = (
        app.state.results.register(target.results_file)
        if target is not None and target.results_file is not None
        else None
    )
    app.state.active_run_id = target.run_id if target is not None else None

    # Registering on startup means the projects list always contains the thing
    # the user actually asked for — but only if it is a model. Registering any
    # directory would mean that merely starting the server in the wrong place
    # permanently added it as a "project".
    if target is not None and target.kind == "workspace":
        app.state.active_workspace = app.state.storage.open(target.path)
    else:
        app.state.active_workspace = None

    @app.get("/api/health")
    def health() -> dict:
        active = app.state.active_workspace
        target = app.state.target
        return {
            "status": "ok",
            # The frontend switches its whole shell on this rather than inferring
            # from a null workspace id, which conflated "opened a results file"
            # with "opened a folder that has no model in it".
            "mode": target.kind if target else "unknown",
            "landing": target.landing if target else "/projects",
            "capabilities": target.capabilities if target else {},
            "workspace": str(app.state.workspace),
            "workspace_id": active.id if active else None,
            "results_handle": app.state.active_results,
            "run_id": app.state.active_run_id,
            # Where the recents list lives. Shown on that screen, because a list
            # of the user's own folders kept in an invisible state directory is
            # otherwise something they can neither find nor reset.
            "registry_path": str(app.state.storage.registry_path),
            "calligraph_version": _version(),
        }

    app.include_router(api_router)
    _mount_frontend(app)
    return app


def _results_candidates(state) -> list[Path]:
    """Every `results.nc` a handle could refer to.

    A handle is a truncated hash of a path, so it cannot be inverted; the only way
    to resolve one this process never minted is to hash the paths it could have
    come from. Cheap: a stat per run directory, and only on a cache miss.
    """
    candidates = []
    if state.workspace.suffix == ".nc" and state.workspace.is_file():
        candidates.append(state.workspace)
    for root in state.storage.run_roots():
        if root.is_dir():
            candidates.extend(root.glob(f"*/{protocol.RESULTS_FILE}"))
    return candidates


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
        # An unmatched /api path is a bug, not a client-side route. Serving
        # index.html for it would hand the frontend HTML where it expects JSON
        # and make a typo'd or withdrawn endpoint look like a success.
        if path == "api" or path.startswith("api/"):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="No such endpoint."
            )
        candidate = STATIC_DIR / path
        if path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(index)


def _version() -> str:
    from calligraph import __version__

    return __version__


def __getattr__(name: str):
    """Builds the module-level `app` on first access, not at import.

    `uvicorn calligraph.server.app:app` resolves this attribute when it starts
    serving, by which point the CLI has set `$CALLIGRAPH_WORKSPACE`. Building it
    eagerly at import time would instead capture whatever the workspace was when
    something first imported this module — which, because the CLI imports it for
    a constant, meant every run silently served the working directory.
    """
    if name == "app":
        return create_app()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
