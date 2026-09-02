"""The model's math: what it declares, and what that math actually says.

Two endpoints for two questions, because they cost four orders of magnitude
apart and only one of them can answer while the model is broken.

`GET .../math/sources/` is a YAML walk. It says which math files the model
registers, which of them are enabled, and which are declared and then never
switched on — the last of which is the easiest way to write custom math that
does nothing at all. It works on a model that does not build, which is when a
user most needs it.

`POST .../math/` renders. That is Calliope's LaTeX backend over the whole
formulation: 4 seconds on `national_scale` and 8 on `urban_scale`, all of it
parsing every expression and every `where`. It cannot run in the request
threadpool — a synchronous endpoint would hold a worker thread for the duration
and offer no way out of it — so it is a task, in a subprocess, cancelled through
the same process-group kill a run and a validation use.

The envelope matches `routes.validate`'s deliberately, so the frontend polls the
same shape it already knows:

    {"task_id": str | None, "status": ..., "phase": ..., "result": ... | None}

A rendering is expensive and deterministic, so it is kept — twice over, and the
two caches answer different questions. `_RENDERED` is this process's memory of
what it last rendered for a workspace, keyed on the files' mtimes. `runs.mathcache`
is on disk in the state directory, keyed on what the LaTeX backend actually reads,
and so survives a restart, an edit that cannot change the notation, and the model
being a different copy of the same thing.
"""

import hashlib
import json
import threading

from fastapi import APIRouter, Depends, HTTPException, status

from calliope_studio.modeldef.imports import find_model_yaml
from calliope_studio.modeldef.mathdef import math_components, math_sources
from calliope_studio.runs import mathcache, mathdoc, protocol
from calliope_studio.runs.manager import RunManager, WorkerStartError
from calliope_studio.server import resolution
from calliope_studio.server.deps import (
    get_resolver,
    get_runs,
    get_storage,
    get_workspace,
)
from calliope_studio.server.resolution import Resolver
from calliope_studio.server.storage import MATH_CACHE_RETENTION, LocalStorage, Workspace

router = APIRouter(tags=["math"])

PHASE = "math"

#: Workspace id → (fingerprint, task id) for the last rendering that succeeded.
#:
#: Rendering is a pure function of the files, and `resolution.fingerprint` is
#: already the statement of what those files are — so an unchanged model can hand
#: back the task it rendered last time instead of spending another eight seconds
#: on an identical answer. Opening and closing the Math tab is otherwise a very
#: expensive no-op.
#:
#: Also what tells the tab its payload has gone stale: the fingerprint moving is
#: exactly the condition under which the notation on screen may no longer be the
#: notation in the files.
_RENDERED: dict[str, tuple[tuple, str]] = {}
_LOCK = threading.Lock()


@router.get("/versions/{id}/math/sources/")
def get_math_sources(workspace: Workspace = Depends(get_workspace)) -> dict:
    """Which math this model declares, applies, and declares without applying."""
    return {
        "sources": math_sources(workspace.path),
        "components": math_components(workspace.path),
        "fingerprint": _digest(workspace),
    }


@router.post("/versions/{id}/math/", status_code=status.HTTP_202_ACCEPTED)
def render_math(
    workspace: Workspace = Depends(get_workspace),
    storage: LocalStorage = Depends(get_storage),
    runs: RunManager = Depends(get_runs),
    resolver: Resolver = Depends(get_resolver),
) -> dict:
    """Starts a rendering, or hands back the one that already answers."""
    model_yaml = find_model_yaml(workspace.path)
    if model_yaml is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No model.yaml found in this workspace.",
        )

    current = _digest(workspace)
    with _LOCK:
        cached = _RENDERED.get(workspace.id)
    if cached is not None and cached[0] == current:
        payload = _read_payload(runs, cached[1])
        if payload is not None:
            return _envelope(cached[1], payload, current)

    stored = _from_disk(workspace, storage, resolver, current)
    if stored is not None:
        return stored

    storage.prune_math()
    try:
        record = runs.start(
            storage.math_dir(),
            protocol.RunRequest(
                workspace=str(workspace.path),
                model_file=model_yaml.name,
                math_only=True,
                label=f"math {workspace.name}",
            ),
        )
    except WorkerStartError as problem:
        # The interpreter is this server's own, so a failure here is a broken
        # installation rather than a bad request — 500, with the operating
        # system's own complaint, which is the only thing that says what is
        # actually wrong.
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(problem)
        ) from problem

    return {
        "task_id": record.id,
        "status": "running",
        "phase": PHASE,
        "result": None,
        "fingerprint": current,
    }


def _from_disk(
    workspace: Workspace, storage: LocalStorage, resolver: Resolver, current: str
) -> dict | None:
    """A rendering kept from an earlier session, if one answers for this model.

    Needs a model to compute the key from, and takes it from the resolver, which
    is holding one anyway for the map and the editors. **Only a fresh one**: a
    stale resolution was built from an earlier state of the files, so its key
    names the notation of a model that is no longer on disk.

    The hit still costs `mathdoc.check_inputs`, which is the whole reason it can
    be trusted — see `mathcache`'s docstring on what the key deliberately leaves
    out. A failure there is Calliope's own complaint about the model and is
    reported exactly as the worker path reports it.

    Not recorded in `_RENDERED`, which holds task ids and there is no task here.
    The lookup is a fingerprint and a backend constructor, about 0.15 s against
    the four to eight seconds it replaces.
    """
    resolved = resolver.get(workspace)
    if not resolved.is_resolved or resolved.model is None:
        return None

    # A real `calliope.Model`, not the reader's `LoadedModel`: the fingerprint
    # and the checks both need Calliope's pydantic math and a backend
    # constructor. See `Resolver.calliope_model` for why asking is safe here.
    model = resolver.calliope_model(workspace)
    if model is None:
        return None

    payload = mathcache.read(storage.math_cache_dir(), mathcache.fingerprint(model))
    if payload is None:
        return None

    try:
        mathdoc.check_inputs(model)
    except Exception as caught:
        return _failed(None, str(caught) or "The math could not be read.")
    return _envelope(None, payload, current)


@router.get("/versions/{id}/math/{task_id}/")
def math_status(
    task_id: str,
    workspace: Workspace = Depends(get_workspace),
    runs: RunManager = Depends(get_runs),
    storage: LocalStorage = Depends(get_storage),
) -> dict:
    """Polls a rendering, and returns the payload once there is one."""
    try:
        run_dir = runs.run_dir(task_id)
    except KeyError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Task not found."
        ) from None

    outcome = protocol.read_outcome(run_dir)
    if outcome is None:
        record = runs.get(task_id)
        if record.status in ("failed", "cancelled"):
            # Terminal without an outcome: killed, or died before it could write
            # one. Report it rather than polling forever.
            return _failed(task_id, record.error or f"The rendering {record.status}.")
        return {"task_id": task_id, "status": "running", "phase": PHASE, "result": None}

    if outcome.get("status") != "success":
        # Calliope's own complaint, verbatim. `LatexBackendModel` runs the math's
        # `checks:` block as it builds, so a model whose math is inconsistent
        # fails here with a real message — which is worth showing, not swallowing
        # into an empty pane.
        return _failed(task_id, outcome.get("error") or "The math could not be read.")

    payload = _load(run_dir)
    if payload is None:
        return _failed(task_id, "The rendering produced no output.")

    _store(run_dir, workspace, storage, payload)

    current = _digest(workspace)
    with _LOCK:
        _RENDERED[workspace.id] = (current, task_id)
    return _envelope(task_id, payload, current)


def _store(run_dir, workspace: Workspace, storage: LocalStorage, payload: dict) -> None:
    """Keeps a finished rendering for the next session.

    Under the key the *worker* wrote, not one computed here: only the worker held
    the model that was actually rendered. Absent when the run predates this, in
    which case there is nothing to file it under and it is simply not kept.

    Called from the poll, so a rendering nobody collects is not stored. That is
    the same laziness `resolution._collect` has — nothing here reaches back into a
    finished subprocess — and it costs nothing in practice, because the only way
    to leave a render uncollected is to cancel it, and a cancelled render has no
    payload to keep.
    """
    try:
        key = (run_dir / protocol.MATH_KEY_FILE).read_text(encoding="utf-8").strip()
    except OSError:
        return
    if not key:
        return
    directory = storage.math_cache_dir()
    mathcache.write(directory, key, payload, model_name=workspace.name)
    mathcache.prune(directory, MATH_CACHE_RETENTION)


def _envelope(task_id: str | None, payload: dict, fingerprint: str) -> dict:
    return {
        "task_id": task_id,
        "status": "done",
        "phase": PHASE,
        "result": payload,
        "fingerprint": fingerprint,
    }


def _failed(task_id: str | None, error: str) -> dict:
    return {
        "task_id": task_id,
        "status": "done",
        "phase": PHASE,
        "result": None,
        "error": error,
    }


def _read_payload(runs: RunManager, task_id: str) -> dict | None:
    """The payload of an earlier rendering, if its scratch directory is still there.

    It may not be: `prune_math` removes the oldest, and the whole temp root goes
    at exit. A miss means rendering again, not failing.
    """
    try:
        return _load(runs.run_dir(task_id))
    except KeyError:
        return None


def _load(run_dir) -> dict | None:
    path = run_dir / protocol.MATH_FILE
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def _digest(workspace: Workspace) -> str:
    """The model's fingerprint, as something JSON can carry and a client compare.

    The tuple `resolution.fingerprint` returns holds paths, mtimes and sizes; the
    client needs none of that and only ever asks whether it changed. Hashed with
    sha256 rather than `hash()`, whose value for a string is salted per process —
    so a client that stored one across a server restart would see a change that
    is not one.
    """
    raw = repr(resolution.fingerprint(workspace.path)).encode()
    return hashlib.sha256(raw).hexdigest()[:16]
