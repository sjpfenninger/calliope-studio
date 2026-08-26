"""What the model *means*, according to Calliope.

Calliope Studio reads a model definition two ways, and the distinction is the whole
point of this module.

**Structure** is what the files say: which keys are in which file, in which order,
with which comments. `modeldef` owns it, it works on a half-written model, and it
is what a save writes back. **Meaning** is what the definition resolves to: which
nodes exist and where, which technologies are links, what a parameter is actually
set to once templates, data tables and `active:` have been applied. Calliope owns
that, and until this module existed Calliope Studio answered it with a second
implementation of Calliope's rules — which drifted, as a second implementation
always will. Node coordinates supplied by a data table were invisible to the map;
a template inheriting a template lost half its parameters; `active: false` was
honoured nowhere.

So: we ask. `calliope.read_yaml` in a subprocess writes the model back out as a
`.nc` with no results in it, and everything downstream is the code that already
existed for solved models — `results.store` to load it under the shared byte
budget, `results.geo` to get geometry out of it. A resolved definition and a solved
model differ only in whether `results` is empty.

Three things make this liveable in an editor:

- **It never blocks.** Resolution is a task, like deep validation. `get` returns
  the best answer available immediately and, when a rebuild is in flight, the id of
  the task to poll.
- **It degrades honestly.** `calliope.read_yaml` raises on a node referring to a
  tech that does not exist yet, and on a half-typed `latitude:` — both of which are
  the *normal* state of a file being edited. So there are three states, and callers
  report which one they got rather than quietly showing something else.
- **It knows when it is out of date.** A resolution records the size and mtime of
  every file it was built from, including the data-table CSVs, so an edit anywhere
  in the import graph invalidates it.
"""

import logging
import shutil
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from calliope_studio.modeldef import snapshot
from calliope_studio.modeldef.imports import find_model_yaml
from calliope_studio.results import store as results_store
from calliope_studio.runs import protocol
from calliope_studio.runs.manager import RunManager, WorkerStartError
from calliope_studio.server.storage import LocalStorage, Workspace

LOGGER = logging.getLogger(__name__)

#: From a resolution built from the files exactly as they are now.
SOURCE_RESOLVED = "resolved"

#: From an earlier resolution. The files have changed since, or the current ones
#: do not load. Shown rather than nothing: the last thing that made sense is more
#: use than a blank map, as long as it is labelled.
SOURCE_STALE = "stale"

#: No resolution has ever succeeded for this workspace, so the caller is on its own
#: with the structural reading.
SOURCE_STRUCTURAL = "structural"


@dataclass(frozen=True)
class Resolution:
    """The best answer available about what a model means, and how good it is."""

    source: str
    #: A `calliope.Model`, or None when `source` is `structural`. Untyped to keep
    #: the calliope import out of this module.
    model: Any = None
    #: A resolve in flight, for the client to poll through `GET /tasks/{id}/`.
    task_id: str | None = None
    #: Why the most recent attempt failed, if it did. Worth surfacing: it is
    #: usually the actual problem with the user's model.
    error: str | None = None

    @property
    def is_resolved(self) -> bool:
        return self.source == SOURCE_RESOLVED

    def as_dict(self) -> dict:
        """The part of this a response carries. Never the model itself."""
        payload: dict = {"source": self.source}
        if self.task_id:
            payload["resolve_task"] = self.task_id
        if self.error:
            payload["resolve_error"] = self.error
        return payload


def fingerprint(workspace_path: Path) -> tuple:
    """What the model definition consists of, right now.

    `snapshot.collect` is reused because it already answers "every file this model
    needs" — including the data-table CSVs and the `config.init.math_paths` the
    import graph cannot see, both of which change what the model means without
    touching a single YAML key.

    Size as well as mtime, because an editor writing a file within the same
    coarse-grained mtime tick is not hypothetical.
    """
    root = Path(workspace_path)
    entries = []
    for relative in snapshot.collect(root).files:
        path = root / relative
        try:
            stat = path.stat()
        except OSError:
            entries.append((relative, None, None))
            continue
        entries.append((relative, stat.st_mtime_ns, stat.st_size))
    return tuple(sorted(entries))


@dataclass
class _Entry:
    """One workspace's resolution state."""

    #: Fingerprint the loaded model was built from.
    fingerprint: tuple | None = None
    #: Where its `.nc` lives, so it can be released and removed when superseded.
    artefact: Path | None = None
    #: A resolve in flight, and the fingerprint it was started for.
    task_id: str | None = None
    pending_fingerprint: tuple | None = None
    #: Fingerprint whose resolve failed, so it is not retried on every request.
    failed_fingerprint: tuple | None = None
    error: str | None = None
    #: A real `calliope.Model` over `artefact`, built only if the math path asks
    #: for one. See `Resolver.calliope_model`; cleared whenever `artefact` is.
    calliope_model: Any = None


class Resolver:
    """Keeps one resolved model per workspace, and refreshes it when files change.

    Composed here rather than in a domain layer because it needs all three of them
    — `runs` to start the subprocess, `modeldef` to know which files it was built
    from, `results` to load the artefact — and `server` is the only layer allowed to
    put those together.
    """

    def __init__(self, runs: RunManager, storage: LocalStorage) -> None:
        self._runs = runs
        self._storage = storage
        self._entries: dict[str, _Entry] = {}
        # Every endpoint here is synchronous, so FastAPI runs it in a threadpool and
        # several can be inside this object at once — the editor polls `/geo/` while
        # a resolve is in flight. Without the lock two of them start duplicate
        # resolves, and one can discard the artefact the other is about to load.
        self._lock = threading.RLock()

    # -- the one method callers use ----------------------------------------

    def get(self, workspace: Workspace, *, start: bool = True) -> Resolution:
        """The best available answer about this model, without blocking.

        Args:
            workspace: Whose model to resolve.
            start: Whether to kick off a resolve when the current one is out of
                date. False for callers that only want to report the state.
        """
        with self._lock:
            return self._get(workspace, start=start)

    def _get(self, workspace: Workspace, *, start: bool) -> Resolution:
        entry = self._entries.setdefault(workspace.id, _Entry())
        current = fingerprint(workspace.path)

        self._collect(entry, workspace)

        if entry.fingerprint == current and entry.artefact is not None:
            model = self._loaded(entry)
            if model is not None:
                return Resolution(SOURCE_RESOLVED, model, error=entry.error)

        if (
            start
            and entry.task_id is None
            and entry.failed_fingerprint != current
            and self._resolvable(workspace)
        ):
            self._start(entry, workspace, current)

        model = self._loaded(entry) if entry.artefact is not None else None
        if model is not None:
            return Resolution(
                SOURCE_STALE, model, task_id=entry.task_id, error=entry.error
            )
        return Resolution(
            SOURCE_STRUCTURAL, None, task_id=entry.task_id, error=entry.error
        )

    def refresh(self, workspace: Workspace) -> str | None:
        """Starts a resolve now, whatever the current state.

        Called after a save. Returns the task id, or None when the model cannot be
        resolved at all (no `model.yaml`).
        """
        with self._lock:
            return self._refresh(workspace)

    def _refresh(self, workspace: Workspace) -> str | None:
        entry = self._entries.setdefault(workspace.id, _Entry())
        if entry.task_id is not None:
            return entry.task_id
        if not self._resolvable(workspace):
            return None
        # Clearing this is what makes a save a retry: the user has changed
        # something, so the previous failure is no longer the last word.
        entry.failed_fingerprint = None
        self._start(entry, workspace, fingerprint(workspace.path))
        return entry.task_id

    def forget(self, workspace_id: str) -> None:
        """Releases a workspace's resolution and removes its artefact."""
        with self._lock:
            entry = self._entries.pop(workspace_id, None)
            if entry is not None:
                self._discard(entry.artefact)

    # -- internals ---------------------------------------------------------

    def _resolvable(self, workspace: Workspace) -> bool:

        return find_model_yaml(workspace.path) is not None

    def _loaded(self, entry: _Entry):
        """The model behind the current artefact, or None if it will not load."""
        if entry.artefact is None or not entry.artefact.is_file():
            return None
        try:
            return results_store.load(entry.artefact).model
        except Exception as caught:
            # A `.nc` written by a Calliope that has since changed, or a truncated
            # file. Dropping it means the next request resolves again rather than
            # failing for ever on the same bad artefact.
            entry.error = f"{type(caught).__name__}: {caught}"
            self._discard(entry.artefact)
            entry.artefact = None
            entry.fingerprint = None
            entry.calliope_model = None
            return None

    def _start(self, entry: _Entry, workspace: Workspace, current: tuple) -> None:

        model_yaml = find_model_yaml(workspace.path)
        if model_yaml is None:
            return
        try:
            record = self._runs.start(
                self._storage.resolutions_dir(),
                protocol.RunRequest(
                    workspace=str(workspace.path),
                    model_file=model_yaml.name,
                    init_only=True,
                    label=f"resolve {workspace.name}",
                ),
            )
        except WorkerStartError as problem:
            # Recorded, not raised: this runs behind a request that has a
            # perfectly good structural answer to give, and the resolver's whole
            # contract is to degrade to `source: structural` rather than fail.
            #
            # `failed_fingerprint` is the important half. Without it a broken
            # installation spawns a worker on every request for ever, because
            # nothing else here remembers that this exact set of files has
            # already been tried and could not be.
            entry.failed_fingerprint = current
            entry.error = str(problem)
            return
        entry.task_id = record.id
        entry.pending_fingerprint = current

    def calliope_model(self, workspace: Workspace) -> Any | None:
        """A real `calliope.Model` over the current artefact, for the math path.

        Everything else here is served by `results.store`'s `LoadedModel`, which
        is six plain attributes and no Calliope import — that is what lets a
        user's older `.nc` open at all. The math path cannot use it: both
        `mathcache.fingerprint` and `mathdoc.check_inputs` want the pydantic
        `math` and `config` objects and a real backend constructor, which only
        Calliope can build.

        Asking here is safe in a way that asking about a *results* file would not
        be: an artefact is `resolved.nc`, written minutes ago by this
        installation's own worker, so it is always the current version and always
        the current layout. `routes/math.py` additionally requires
        `is_resolved` — a stale artefact was built from files that have since
        changed, so its math names notation nobody asked for.

        Cached on the entry rather than re-read per request, and dropped with the
        artefact it describes. Returns None if there is nothing to load or
        Calliope will not load it, which is what the caller already does about a
        model it cannot render math for.
        """
        import calliope

        with self._lock:
            entry = self._entries.get(workspace.id)
            if entry is None or entry.artefact is None:
                return None
            if entry.calliope_model is not None:
                return entry.calliope_model
            artefact = entry.artefact

        try:
            model = calliope.read_netcdf(artefact)
        except Exception as caught:
            # Not fatal and not recorded on the entry: the structural and
            # results readings of this artefact are both fine, and only the math
            # tab is affected.
            LOGGER.debug("Calliope could not reload %s: %s", artefact, caught)
            return None

        with self._lock:
            entry = self._entries.get(workspace.id)
            # Only if nothing superseded the artefact while it was loading.
            if entry is not None and entry.artefact == artefact:
                entry.calliope_model = model
        return model

    def _collect(self, entry: _Entry, workspace: Workspace) -> None:
        """Picks up a finished resolve, if one was in flight."""
        if entry.task_id is None:
            return
        try:
            record = self._runs.get(entry.task_id)
        except KeyError:
            # The scratch directory went away — a restart, or pruning.
            entry.task_id = None
            entry.pending_fingerprint = None
            return
        if record.status not in ("success", "failed", "cancelled"):
            return

        task_id, pending = entry.task_id, entry.pending_fingerprint
        entry.task_id = None
        entry.pending_fingerprint = None

        artefact = self._artefact(task_id)
        if record.status == "success" and artefact is not None:
            previous = entry.artefact
            entry.artefact = artefact
            # The cached Calliope model describes `previous`, which is about to
            # be deleted. Left in place it would answer the math path with the
            # math of a definition the user has already changed.
            entry.calliope_model = None
            entry.fingerprint = pending
            entry.error = None
            # Released only now: until the replacement is on disk, the old model is
            # what `stale` was serving.
            if previous is not None and previous != artefact:
                self._discard(previous)
            self.prune()
            return

        entry.error = record.error or "The model could not be read."
        entry.failed_fingerprint = pending
        # The failed directory is left in place: the client is about to poll
        # `GET /tasks/{id}/` for the message, and a deleted directory answers 404
        # instead. `prune` clears the backlog once newer ones exist.
        self.prune()

    def _artefact(self, task_id: str) -> Path | None:
        try:
            path = self._runs.run_dir(task_id) / protocol.RESOLVED_FILE
        except KeyError:
            return None
        return path if path.is_file() else None

    def _discard(self, artefact: Path | None) -> None:
        """Releases a superseded artefact and deletes the directory holding it."""
        if artefact is None:
            return
        results_store.release(artefact)
        shutil.rmtree(artefact.parent, ignore_errors=True)

    def prune(self, keep: int = 4) -> None:
        """Removes finished resolve directories beyond the newest `keep`.

        Only ones nothing points at: the artefact a workspace is currently serving
        must survive however old it looks.
        """
        root = self._storage.resolutions_dir()
        live = {
            entry.artefact.parent
            for entry in self._entries.values()
            if entry.artefact is not None
        }
        finished = [
            directory
            for directory in root.glob("*/")
            if (directory / protocol.OUTCOME_FILE).is_file() and directory not in live
        ]
        finished.sort(key=lambda directory: directory.stat().st_mtime, reverse=True)
        for directory in finished[keep:]:
            shutil.rmtree(directory, ignore_errors=True)
