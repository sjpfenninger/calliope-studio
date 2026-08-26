"""Starting, watching and cancelling runs.

The parent side of the run protocol. Run status is *derived* from what is on
disk rather than stored in memory, so that restarting the server — which happens
constantly under `--reload` — does not lose track of what happened.

Nothing about a run is authoritative in memory. Earlier versions kept the run
directory, the cancellation set and the child processes in dictionaries, which
meant that after a restart `GET /runs/{id}/`, `/cancel/`, `/logs/` and
`/tasks/{id}/` all returned 404 until something happened to list the workspace's
runs first, a cancelled run reported itself as failed, and a solve still running
in its own session was reported as dead. Directory lookup now falls back to
searching the roots injected by the caller, cancellation is a marker file, and
liveness falls back to the recorded pid.
"""

import asyncio
import dataclasses
import os
import re
import shutil
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import AsyncIterator, Callable, Iterable

from calliope_studio.runs import process, protocol

#: How often the event tailer looks for new lines. Fast enough to feel live,
#: slow enough not to spin a core on a long solve.
POLL_INTERVAL = 0.25

TERMINAL_STATUSES = frozenset({"success", "infeasible", "failed", "cancelled"})

#: How long to let a finished run's worker finish exiting before removing its
#: directory. Generous for what it is — the process has already written its
#: outcome, so this covers interpreter shutdown and nothing else.
EXIT_GRACE_SECONDS = 10.0

#: A run id is a UUID, and it is about to be joined to a filesystem path. Any
#: other shape is a probe: without this, `GET /api/runs/..%2f..%2fetc/` would
#: resolve outside the runs root. The guard is new because `run_dir` used to be
#: a dictionary lookup and so never touched the filesystem at all.
RUN_ID_RE = re.compile(r"\A[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\Z")


class RunStillActive(RuntimeError):
    """Raised when an operation needs a run to have finished, and it has not."""


class WorkerStartError(RuntimeError):
    """Raised when the worker process could not be spawned at all.

    Distinct from a run that starts and then fails: nothing was solved, no
    `outcome.json` exists and none ever will, so the caller can refuse the
    request outright instead of writing a run into the history that has nothing
    in it. What `Popen` raises here is an `OSError` about an executable, which
    says nothing about runs.
    """


@dataclass(frozen=True)
class RunRecord:
    """A run's current state, as far as the filesystem knows."""

    id: str
    status: str
    created_at: str

    # -- what was asked for, echoed from request.json and meta.json --------
    label: str | None = None
    workspace: str | None = None
    scenario: str | None = None
    override_dict: dict = field(default_factory=dict)
    build_only: bool = False

    # -- what happened, from outcome.json ---------------------------------
    started_at: str | None = None
    completed_at: str | None = None
    duration_seconds: float | None = None
    termination_condition: str | None = None
    solver: str | None = None
    objective: float | None = None
    #: Calliope's own stage timings. Written to `outcome.json` and, until the
    #: worker's `.root` bug was fixed, never actually populated.
    timings: dict = field(default_factory=dict)
    error: str | None = None
    #: Only present on a run that failed; long, and pure noise otherwise.
    traceback: str | None = None

    # -- what is available to open ----------------------------------------
    has_results: bool = False
    has_snapshot: bool = False
    #: False when the snapshot could not capture everything the model refers to,
    #: so the frozen tree is not the whole story. None when there is no snapshot.
    snapshot_complete: bool | None = None
    #: `"snapshot"` or `"workspace"` — which tree the worker actually read.
    solved_from: str | None = None
    #: Total size of the run directory. The Runs page shows it, and it is the
    #: only way a user can see what their history is costing them.
    size_bytes: int = 0

    def as_dict(self) -> dict:
        # Generated rather than hand-written: at twenty fields the explicit
        # version is a maintenance liability, and its only advantage —
        # controlling key order — is worthless over JSON.
        return dataclasses.asdict(self)


def _directory_size(path: Path) -> int:
    """Total bytes under a directory, ignoring anything that vanishes mid-walk."""
    total = 0
    for child in path.rglob("*"):
        try:
            if child.is_file():
                total += child.stat().st_size
        except OSError:
            continue
    return total


#: How much of `run.log` to quote when a worker died without saying anything.
#: A traceback and the import chain above it, and not so much that a solver's
#: last few thousand lines of output arrive as an error message.
LOG_TAIL_BYTES = 8192


def _log_tail(run_dir: Path, limit: int = LOG_TAIL_BYTES) -> str | None:
    """The last `limit` bytes of `run.log`, or None if there is nothing there.

    This is the only evidence a worker that died before it could append a single
    event leaves behind — a bad interpreter, a missing dependency, a syntax error
    under a Python older than the worker supports. `GET /runs/{id}/logs/` streams
    `events.jsonl`, which such a run never wrote a line of, and `run.log` is
    served by no endpoint, so without this the failure reads only as *"Run did
    not complete; the process is no longer present."*

    Read in binary from the end: the file may hold a solver's whole output, and
    decoding megabytes to keep the last few lines is waste. `errors="replace"`
    because a tail can begin mid-character, and because a solver writing bytes
    straight to fd 1 is under no obligation to be valid UTF-8.
    """
    path = run_dir / protocol.LOG_FILE
    try:
        with open(path, "rb") as handle:
            handle.seek(0, os.SEEK_END)
            handle.seek(max(0, handle.tell() - limit))
            raw = handle.read()
    except OSError:
        return None
    text = raw.decode("utf-8", errors="replace").strip()
    return text or None


def _pid_alive(pid: int, run_id: str | None = None) -> bool:
    """Whether a worker is still running.

    Delegates to `process`, which is where the platform difference lives. The
    group name is passed where the caller has one: on Windows the job's
    existence answers this without touching the pid at all, which is immune to
    the pid reuse the POSIX side has to accept.
    """
    group = None if run_id is None else protocol.group_name(run_id)
    return process.is_running(pid, group)


class RunManager:
    """Owns the child processes and resolves run ids to directories."""

    def __init__(
        self,
        search_roots: Callable[[], Iterable[Path]] | None = None,
        release: Callable[[Path], None] | None = None,
    ) -> None:
        """
        Args:
            search_roots: Called to enumerate directories that may contain run
                directories, when asked for a run this process did not start.
                Injected rather than imported because `runs` knows nothing about
                workspaces — that is `server`'s concern. Defaults to knowing
                nothing, which makes lookups memory-only as they were before.
            release: Called with a `.nc` about to be deleted, to drop any loaded
                model still holding it open. Injected for the same reason and a
                stricter one: `runs` may not import `results` at all, and
                `results.store.release` is what has to be called. Without it a
                run's results file is deleted while the byte-budgeted cache still
                holds its netCDF handle — which POSIX tolerates and Windows does
                not, where `rmtree` then removes nothing and, with
                `ignore_errors=True`, says so to nobody.
        """
        self._processes: dict[str, subprocess.Popen] = {}
        self._dirs: dict[str, Path] = {}
        self._search_roots = search_roots or (lambda: ())
        self._release = release or (lambda _path: None)

    # -- lookup -----------------------------------------------------------

    def register_dir(self, run_id: str, run_dir: Path) -> None:
        self._dirs[run_id] = run_dir

    def run_dir(self, run_id: str) -> Path:
        """Finds a run's directory, searching the known roots on a miss.

        Raises:
            KeyError: If the id is not a UUID, or no root contains it.
        """
        if not RUN_ID_RE.match(run_id):
            raise KeyError(run_id)

        cached = self._dirs.get(run_id)
        if cached is not None and (cached / protocol.REQUEST_FILE).is_file():
            return cached

        for root in self._search_roots():
            candidate = root / run_id
            if (candidate / protocol.REQUEST_FILE).is_file():
                self._dirs[run_id] = candidate
                return candidate

        # Drop a stale entry, so a deleted run stops resolving to a dead path.
        self._dirs.pop(run_id, None)
        raise KeyError(run_id)

    def forget(self, run_id: str) -> None:
        """Drops a deleted run from the lookup cache."""
        self._dirs.pop(run_id, None)
        self._processes.pop(run_id, None)

    def delete(self, run_id: str) -> None:
        """Removes a run and everything it produced.

        Raises:
            KeyError: If the run is unknown.
            RunStillActive: If it has not finished. Deleting the directory out
                from under a live worker would leave it writing events into
                nothing and its results nowhere, so the caller has to cancel
                first and decide what to tell the user.
        """
        run_dir = self.run_dir(run_id)
        if self.get(run_id).status not in TERMINAL_STATUSES:
            raise RunStillActive(run_id)
        # A terminal outcome and a departed process are different facts, and
        # removal needs the second. The worker writes `outcome.json`, *then*
        # appends the `done` event, returns through `main`, and only then goes
        # through interpreter shutdown — closing netCDF handles, flushing,
        # collecting. The check above is satisfied at the first of those, so
        # without this a delete issued promptly races a worker that still holds
        # the `run.log` it inherited.
        #
        # POSIX unlinks open files happily, which is why this was invisible
        # until Windows refused. Someone clicking delete the moment a run
        # finishes is the ordinary case, not a contrived one.
        self._await_exit(run_id, run_dir)
        # Before the delete, not after: the results cache may still hold this
        # file open, and an open handle is what makes the removal fail. The
        # resolver has done it this way around `_discard` all along.
        self._release(run_dir / protocol.RESULTS_FILE)
        self._release(run_dir / protocol.RESOLVED_FILE)
        # No `ignore_errors`: the user asked for this and a 204 that deleted
        # nothing is a lie. `OSError` reaches the route, which reports it.
        #
        # Remove what can be removed, then report by *inspection* rather than by
        # catching. On Windows the release above is necessary and has proved not
        # to be sufficient, and "could not remove the run" is not a diagnosis —
        # which of `run.log`, `events.jsonl` and `results.nc` is still held is
        # the whole question, and a traceback saying `rmtree` cannot answer it.
        #
        # Inspecting the leftovers rather than using `onexc`, which is 3.12+
        # while this package supports 3.10, and `onerror` is deprecated in the
        # same release. It is also the better signal: what survived is the fact,
        # where an error callback reports only the first attempt that failed.
        shutil.rmtree(run_dir, ignore_errors=True)
        if run_dir.exists():
            survivors = sorted(
                path.name for path in run_dir.rglob("*") if path.is_file()
            )
            raise OSError(
                f"could not remove {run_dir.name}; still present: "
                f"{', '.join(survivors) or 'the directory itself'}"
            )
        self.forget(run_id)

    def _await_exit(self, run_id: str, run_dir: Path) -> None:
        """Waits briefly for a finished run's worker to actually be gone.

        Bounded and forgiving: the run has already reported a terminal outcome,
        so a worker still present is a process on its way out, not one doing
        work. If it somehow outlasts the budget the delete proceeds anyway and
        `rmtree` reports what it could not remove — refusing to delete because a
        process is slow to exit would be the worse failure.
        """
        deadline = time.monotonic() + EXIT_GRACE_SECONDS
        child = self._processes.get(run_id)
        if child is not None:
            try:
                child.wait(timeout=EXIT_GRACE_SECONDS)
            except subprocess.TimeoutExpired:
                pass
            return

        # Orphaned by a restart: no `Popen` to wait on, so poll the recorded pid
        # the same way `_is_alive` does.
        pid = protocol.read_pid(run_dir)
        if pid is None:
            return
        while time.monotonic() < deadline:
            if not _pid_alive(pid, run_id):
                return
            time.sleep(0.05)

    def discover(self, runs_root: Path) -> list[RunRecord]:
        """Finds runs already on disk, newest first, so history survives a restart.

        Ordered by when each run was requested, not by directory name: the names
        are UUIDs, so sorting them puts the history in an arbitrary order that
        merely looks deliberate.
        """
        if not runs_root.is_dir():
            # Nothing has been run in this workspace yet. Listing must not be
            # what creates the directory — see `LocalStorage.runs_dir`.
            return []

        records = []
        for directory in runs_root.glob("*/"):
            if not (directory / protocol.REQUEST_FILE).is_file():
                continue
            self._dirs.setdefault(directory.name, directory)
            records.append(self.get(directory.name))

        # Sorted on the record rather than the file's mtime, so that a workspace
        # copied or restored from backup keeps its history in the right order.
        records.sort(key=lambda record: record.created_at, reverse=True)
        return records

    # -- lifecycle --------------------------------------------------------

    def start(
        self,
        runs_root: Path,
        request: protocol.RunRequest,
        prepare: Callable[[Path], None] | None = None,
    ) -> RunRecord:
        """Starts a run in a fresh directory and returns immediately.

        Args:
            runs_root: Directory to create the run's own directory inside.
            request: What to run.
            prepare: Called with the new run directory before the request is
                written and before the worker exists. This is where the model
                definition is frozen. Doing it here rather than in the worker is
                what makes the snapshot atomic: there is no moment in which the
                user could edit a file that was about to be captured. Passed in as
                a callback rather than called directly because freezing needs
                `modeldef`, and `runs` may not import it.
        """
        run_id = str(uuid.uuid4())
        run_dir = runs_root / run_id
        run_dir.mkdir(parents=True, exist_ok=True)

        if prepare is not None:
            try:
                prepare(run_dir)
            except Exception:
                # `request.json` is what makes a directory a run, and it has not
                # been written yet, so removing the directory leaves no trace in
                # the history rather than a permanently broken entry.
                shutil.rmtree(run_dir, ignore_errors=True)
                raise

        # Stamped here rather than by each caller: this is the one place that
        # knows a run is being created right now, and the timestamp has to be in
        # the file for the history to survive the workspace being copied.
        if not request.requested_at:
            request = dataclasses.replace(
                request, requested_at=datetime.now(timezone.utc).isoformat()
            )
        request.write(run_dir)
        self.register_dir(run_id, run_dir)

        # Closed as soon as the child has inherited it: the parent has no use for
        # the handle, and holding one open per run leaks a descriptor for the
        # lifetime of the server.
        with open(run_dir / protocol.LOG_FILE, "w") as log_file:
            try:
                # Its own killable group, so cancelling kills the solver too
                # rather than leaving it orphaned and still burning CPU. How a
                # group is made is `process`'s business, not this module's.
                child = process.spawn(
                    [sys.executable, "-m", "calliope_studio.runs.worker", str(run_dir)],
                    log_file=log_file,
                )
            except OSError as problem:
                # The run directory stays, with its `request.json` and snapshot:
                # the user asked for this and the history should say it was
                # refused. What it must not do is sit in the list reporting
                # "running" for ever, which is what an unraised spawn failure
                # would produce — `_is_alive` finds no process and no pid file.
                raise WorkerStartError(
                    f"Could not start the run worker: {problem}"
                ) from problem
        self._processes[run_id] = child
        # Recorded on disk as well as in memory, so that a server restarted
        # mid-solve can still tell this run is alive, and still cancel it.
        protocol.write_pid(run_dir, child.pid)
        return self.get(run_id)

    def _created_at(self, run_dir: Path, request: protocol.RunRequest | None) -> str:
        """When the run was requested.

        Prefers the timestamp recorded inside `request.json` over the file's
        mtime. An mtime is lost the moment a workspace is copied, restored from
        a backup or checked out, which silently reshuffles the whole history.
        Falls back to the mtime for runs made before it was recorded.
        """
        if request is not None and request.requested_at:
            return request.requested_at
        return datetime.fromtimestamp(
            (run_dir / protocol.REQUEST_FILE).stat().st_mtime, tz=timezone.utc
        ).isoformat()

    def _is_alive(self, run_id: str, run_dir: Path) -> bool:
        """Whether the run's worker is still running."""
        child = self._processes.get(run_id)
        if child is not None:
            return child.poll() is None
        # No tracked child, but the worker is started with `start_new_session`
        # and outlives the server, so the recorded pid is the only remaining
        # evidence. Pid reuse could in principle make this a false positive; on
        # a local desktop between one restart and the next, that is not a risk
        # worth a second mechanism.
        pid = protocol.read_pid(run_dir)
        return pid is not None and _pid_alive(pid, run_id)

    def get(self, run_id: str, *, with_size: bool = True) -> RunRecord:
        """Derives a run's state from its directory, markers and any live process.

        Args:
            run_id: The run to look up.
            with_size: Whether to total the directory's bytes. That is an `rglob`
                and a `stat` per file over a directory containing a results file
                of some hundreds of megabytes, which is affordable for a listing
                and not at all affordable four times a second — so the tailer,
                which only wants the status, asks without it.
        """
        run_dir = self.run_dir(run_id)
        try:
            request = protocol.RunRequest.read(run_dir)
        except (OSError, ValueError, TypeError):
            request = None

        meta = protocol.read_meta(run_dir)
        manifest = protocol.read_snapshot_manifest(run_dir)
        outcome = protocol.read_outcome(run_dir) or {}

        common = dict(
            id=run_id,
            created_at=self._created_at(run_dir, request),
            # `meta.json` wins, so a rename sticks; the request's label is what
            # the run was christened at birth.
            label=meta.get("label") or (request.label if request else None),
            workspace=request.workspace if request else None,
            scenario=request.scenario if request else None,
            override_dict=(request.override_dict if request else None) or {},
            build_only=bool(request.build_only) if request else False,
            has_results=(run_dir / protocol.RESULTS_FILE).is_file(),
            has_snapshot=(run_dir / protocol.SNAPSHOT_DIR).is_dir(),
            snapshot_complete=manifest.get("complete") if manifest else None,
            solved_from=outcome.get("solved_from")
            or (manifest.get("solve_from") if manifest else None),
            size_bytes=_directory_size(run_dir) if with_size else 0,
        )

        if outcome:
            status = outcome.get("status", "failed")
            if protocol.is_cancelled(run_dir):
                status = "cancelled"
            return RunRecord(
                status=status,
                started_at=outcome.get("started_at"),
                completed_at=outcome.get("completed_at"),
                duration_seconds=outcome.get("duration_seconds"),
                termination_condition=outcome.get("termination_condition"),
                solver=outcome.get("solver"),
                objective=outcome.get("objective"),
                timings=outcome.get("timings") or {},
                error=outcome.get("error"),
                traceback=outcome.get("traceback"),
                **common,
            )

        if protocol.is_cancelled(run_dir):
            return RunRecord(status="cancelled", **common)

        if self._is_alive(run_id, run_dir):
            return RunRecord(status="running", **common)

        # No outcome file, no cancellation marker and no live process: the worker
        # died hard. Reporting "failed" is honest; claiming "running" would hang
        # the UI forever.
        #
        # `run.log` is the only place such a death is recorded — the worker never
        # reached the point of appending an event — so it is quoted here rather
        # than left on disk for nobody. Without it every one of these failures
        # looks identical and says nothing about its cause.
        return RunRecord(
            status="failed",
            error="Run did not complete; the process is no longer present.",
            traceback=_log_tail(run_dir),
            **common,
        )

    async def cancel(self, run_id: str) -> None:
        """Terminates a run.

        Calliope offers no interrupt API — no timeout, no solver callback, no
        `KeyboardInterrupt` handling — so killing the process group is the only
        way to stop a solve.
        """
        run_dir = self.run_dir(run_id)
        # Marked before the kill, so a signal that also reaches this process
        # still leaves the run correctly recorded as cancelled.
        protocol.mark_cancelled(run_dir)

        group = protocol.group_name(run_id)
        child = self._processes.get(run_id)
        if child is not None:
            if child.poll() is not None:
                return
            pid = child.pid
        else:
            # Orphaned by a restart. Reading the pid from disk is what makes
            # such a run cancellable at all; previously it was not.
            pid = protocol.read_pid(run_dir)
            if pid is None or not _pid_alive(pid, run_id):
                return

        def gone() -> bool:
            if child is not None:
                return child.poll() is not None
            return not _pid_alive(pid, run_id)

        # The escalation policy stays here — how a group is signalled is
        # `process`'s business, how long it is given is this module's. On
        # Windows there is no graceful tier and both calls are the same
        # unconditional kill; the worker's own cancellation poll is what gives
        # it a chance to flush there.
        if not process.terminate_group(pid, group):
            return
        deadline = process.GRACE_SECONDS
        while deadline > 0:
            await asyncio.sleep(0.25)
            if gone():
                return
            deadline -= 0.25
        process.kill_group(pid, group)

    # -- streaming --------------------------------------------------------

    async def stream(self, run_id: str) -> AsyncIterator[dict]:
        """Yields the run's events, replaying history then following live ones.

        Replaying from the start means a client that connects late, or
        reconnects, still sees the whole log.

        Reads pick up from a byte offset rather than re-reading the file and
        discarding what has already been sent. That was quadratic in the length
        of the log, and survivable only while the log was a handful of lines a
        second — the solver's own output now goes through here too.
        """
        run_dir = self.run_dir(run_id)
        offset = 0

        async def drain() -> list[dict]:
            nonlocal offset
            events, offset = await asyncio.to_thread(
                protocol.read_events_from, run_dir, offset
            )
            return events

        while True:
            events = await drain()
            for event in events:
                yield event
            if any(event.get("t") == "done" for event in events):
                return

            status = (await asyncio.to_thread(self.get, run_id, with_size=False)).status
            if status in TERMINAL_STATUSES:
                # One more read before giving up: the worker writes its outcome
                # before the event announcing it, so a run can be terminal here
                # while its last few events are still unread.
                for event in await drain():
                    yield event
                    if event.get("t") == "done":
                        return
                # Terminal without a `done` event: the worker was killed. Say so
                # rather than streaming forever.
                yield {"t": "done", "status": status}
                return

            await asyncio.sleep(POLL_INTERVAL)
