"""The file layout and event format shared by the run worker and its parent.

Runs communicate through files rather than a pipe. That costs a little more code
than reading the child's stdout, and buys three things worth having:

- the server can be restarted (or reloaded in development) without losing a run
  in flight or its output;
- a finished run can be reopened and its log replayed, because it was never
  only in memory;
- Calliope's own logging setup clears handlers on the `calliope` logger and
  attaches its own to stdout, so stdout is not ours to define a protocol on.

Layout under `{workspace}/calliope-studio/runs/{run_id}/`:

    request.json    what to run; written by the parent before starting
    snapshot.json   what was frozen, and whether the freeze is complete
    snapshot/       the frozen model definition, in workspace-relative layout
    meta.json       user-editable metadata (currently just a label)
    worker.pid      the child's pid, so a restarted server can spot a live run
    cancelled       presence means cancellation was requested
    events.jsonl    the structured event stream; appended by the worker
    run.log         raw child stdout/stderr, a debugging backstop
    outcome.json    terminal status; written by the worker as its last act
    results.nc      the solved model
    resolved.nc     the model as Calliope understands it, unsolved (init_only)

Everything except `request.json` is optional. A directory is a run if and only if
it contains `request.json`, and every reader below returns `None`/`{}`/`False`
for an absent file — run directories outlive the code that wrote them, so a run
made by an older version must still appear in the history.
"""

import dataclasses
import json
import os
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator

REQUEST_FILE = "request.json"
EVENTS_FILE = "events.jsonl"
LOG_FILE = "run.log"
OUTCOME_FILE = "outcome.json"
RESULTS_FILE = "results.nc"

#: The model definition as Calliope resolves it, with no results in it. Written
#: instead of `results.nc` when the request is `init_only`.
#:
#: A separate name rather than reusing `results.nc` on purpose: `has_results` is
#: what mints a results handle and opens a run tab on charts, and an unsolved
#: model would fail every one of those queries.
RESOLVED_FILE = "resolved.nc"

#: The model's math, rendered to LaTeX per component. Written instead of
#: `results.nc` when the request is `math_only`.
#:
#: JSON rather than a `.nc` because none of it is array data — it is a few hundred
#: strings — and because the browser reads it directly rather than through the
#: results store.
MATH_FILE = "math.json"

#: The fingerprint the rendering beside it was made from; see `runs.mathcache`.
#:
#: Written by the worker rather than computed by the server, because the worker's
#: model is the one that was actually rendered. The server holds a *resolved*
#: model that may have been built from an earlier state of the files, and keying
#: a payload with it would file the right answer under the wrong name.
MATH_KEY_FILE = "math.key"

#: The frozen model definition, and the manifest describing it. Written by the
#: parent before the run starts; see `calliope_studio.modeldef.snapshot`.
SNAPSHOT_DIR = "snapshot"
SNAPSHOT_FILE = "snapshot.json"

#: User-editable run metadata. Kept apart from `request.json` because that file
#: is written once and never touched again, which is what makes it a trustworthy
#: record of what was asked for.
META_FILE = "meta.json"

#: The worker's pid. The worker is started with `start_new_session=True` and so
#: outlives the server; without this, a server restarted mid-solve reports a
#: perfectly healthy run as failed.
PID_FILE = "worker.pid"


def group_name(run_id: str) -> str:
    """The name of the killable process group a run's worker belongs to.

    Derived from the run id rather than written down, so nothing new goes on
    disk and a restarted server can name a group it never created. Safe to put
    in a kernel namespace unescaped: `manager.RUN_ID_RE` has already established
    that a run id is a UUID.

    Used only where a group has a name — Windows job objects. POSIX identifies
    the same group by the leader's pid, which is in `PID_FILE` already.
    """
    return f"calliope-studio-run-{run_id}"


#: Presence means cancellation was requested. A file rather than a set in memory,
#: so that cancelling and then restarting does not report "failed" with the
#: message "the process is no longer present" — technically true, and misleading.
CANCELLED_FILE = "cancelled"

#: Ordered stages a run passes through, for the frontend's progress display.
#:
#: These are Calliope's own divisions, not this package's wrapper boundaries —
#: see `calliope_studio.runs.stages`. `solve` used to cover the solver *and*
#: postprocessing, which on a real model is where all of the time goes and so
#: the one place a progress display was worth having.
#:
#: Not every run visits every stage: an `init_only` request goes straight from
#: `preprocess` to `save`.
STAGES = ("preprocess", "build", "solve", "postprocess", "save")


@dataclass(frozen=True)
class RunRequest:
    """What the worker should run."""

    workspace: str
    model_file: str = "model.yaml"
    scenario: str | None = None
    override_dict: dict = field(default_factory=dict)
    build_only: bool = False
    #: Read the model and stop, writing `resolved.nc`.
    #:
    #: This is how anything that needs to know what a model *means* — which nodes
    #: exist and where, which techs are links, what a parameter resolves to — gets
    #: its answer from Calliope instead of from a second implementation of
    #: Calliope's rules. Cheaper than `build_only`, which assembles the math.
    init_only: bool = False
    #: Read the model, render its math to LaTeX and stop, writing `math.json`.
    #:
    #: Like `init_only` this never calls `model.build()`: Calliope's LaTeX backend
    #: is a backend in its own right and assembles nothing a solver would use. It
    #: is still seconds of parsing on a real model, which is why it is out here
    #: rather than in the request that serves the Math tab.
    math_only: bool = False
    #: What the user called this run when they started it. `meta.json` overrides
    #: it if the run has since been renamed.
    label: str | None = None
    #: When the run was requested. Recorded in the file rather than inferred from
    #: its mtime, which is lost the moment a workspace is copied, restored from a
    #: backup or checked out — silently reshuffling the whole run history.
    requested_at: str | None = None

    def write(self, run_dir: Path) -> None:
        (run_dir / REQUEST_FILE).write_text(
            json.dumps(dataclasses.asdict(self), indent=2)
        )

    @classmethod
    def read(cls, run_dir: Path) -> "RunRequest":
        """Reads a request, ignoring fields this version does not know about.

        Filtering rather than passing the whole dict through: otherwise the day a
        field is renamed or removed, every existing run raises `TypeError` during
        discovery and the user's entire history disappears.
        """
        raw = json.loads((run_dir / REQUEST_FILE).read_text())
        known = {field_.name for field_ in dataclasses.fields(cls)}
        return cls(**{key: value for key, value in raw.items() if key in known})


#: Serialises appends within the worker. Solver output is captured on a reader
#: thread while the main thread is announcing stages, and an O_APPEND write is
#: only atomic below `PIPE_BUF` — a solver line is not bounded by anything.
_APPEND_LOCK = threading.Lock()


def append_event(run_dir: Path, event: dict) -> None:
    """Appends one event, flushed, so a reader tailing the file sees it promptly."""
    line = json.dumps(event, default=str) + "\n"
    with _APPEND_LOCK:
        with open(run_dir / EVENTS_FILE, "a") as fh:
            fh.write(line)
            fh.flush()


def read_events(run_dir: Path) -> Iterator[dict]:
    """Replays the events written so far, skipping any partial trailing line."""
    events, _ = read_events_from(run_dir, 0)
    yield from events


def read_events_from(run_dir: Path, offset: int) -> tuple[list[dict], int]:
    """Events after `offset` bytes, and where to resume from next time.

    Byte offsets rather than a line count because this is called four times a
    second per client watching a run, and re-reading the whole file to throw away
    everything already seen is quadratic in the length of the log — which was
    tolerable only while the log was a few dozen lines and the solver's own
    output went somewhere else entirely.

    The returned offset is the end of the last *complete* line, so a partially
    written event is simply read again whole on the next call.

    Read in binary: a text-mode `seek` only accepts a cookie from `tell`, and the
    offset here has to be a plain byte count for the caller to carry between
    calls.
    """
    path = run_dir / EVENTS_FILE
    if not path.is_file():
        return [], offset

    events: list[dict] = []
    with open(path, "rb") as fh:
        fh.seek(offset)
        for raw in fh:
            if not raw.endswith(b"\n"):
                break  # a partially written line; the next poll will see it whole
            offset += len(raw)
            try:
                events.append(json.loads(raw))
            except (json.JSONDecodeError, UnicodeDecodeError):
                continue
    return events, offset


def _read_json(path: Path) -> dict[str, Any] | None:
    """A JSON object from disk, or None if it is absent or unreadable.

    Unreadable counts as absent throughout this module: a half-written or
    corrupted sidecar file must degrade the run's record, never break the
    listing that every other run appears in.
    """
    try:
        loaded = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    return loaded if isinstance(loaded, dict) else None


#: How many times to retry `os.replace` over an existing file, and how long to
#: wait between attempts.
#:
#: Windows only in practice. `MoveFileExW` fails outright if *anything* holds the
#: destination — another reader, an antivirus scanner mid-scan, a search indexer
#: — where POSIX `rename` simply unlinks the old name and carries on. Half a
#: second of retries covers a scanner; anything longer is a genuine lock and
#: should be reported rather than waited out.
REPLACE_ATTEMPTS = 10
REPLACE_DELAY = 0.05


def _replace_retrying(source: str | Path, destination: Path) -> None:
    """`os.replace`, retried briefly when the destination is momentarily held."""
    for attempt in range(REPLACE_ATTEMPTS):
        try:
            os.replace(source, destination)
            return
        except PermissionError:
            if attempt == REPLACE_ATTEMPTS - 1:
                raise
            time.sleep(REPLACE_DELAY)


def write_json_atomic(path: Path, payload: Any) -> None:
    """Replaces a JSON file atomically, creating it if it is not there.

    Public because `server.storage` writes the workspace registry exactly this
    way and had its own copy — including the same Windows-blind `os.replace`. A
    registry lost to a half-written file is every model the user has ever opened,
    so the two must not drift.

    `default=str` because outcomes carry timestamps and numpy scalars.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(payload, fh, indent=2, default=str)
        _replace_retrying(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def read_outcome(run_dir: Path) -> dict[str, Any] | None:
    """The terminal outcome, or None if the run has not finished."""
    return _read_json(run_dir / OUTCOME_FILE)


def write_outcome(run_dir: Path, outcome: dict) -> None:
    (run_dir / OUTCOME_FILE).write_text(json.dumps(outcome, indent=2, default=str))


def read_snapshot_manifest(run_dir: Path) -> dict[str, Any] | None:
    """The snapshot manifest, or None for a run made before snapshots existed."""
    return _read_json(run_dir / SNAPSHOT_FILE)


def write_snapshot_manifest(run_dir: Path, manifest: dict) -> None:
    (run_dir / SNAPSHOT_FILE).write_text(json.dumps(manifest, indent=2, default=str))


def read_meta(run_dir: Path) -> dict[str, Any]:
    """User-editable run metadata; empty for a run that has never been edited."""
    return _read_json(run_dir / META_FILE) or {}


def write_meta(run_dir: Path, meta: dict) -> None:
    """Replaces the run's metadata atomically.

    Atomic because a half-written `meta.json` would make the run look unnamed
    forever, and there is no other copy of the name.
    """
    write_json_atomic(run_dir / META_FILE, meta)


def mark_cancelled(run_dir: Path) -> None:
    (run_dir / CANCELLED_FILE).touch()


def is_cancelled(run_dir: Path) -> bool:
    return (run_dir / CANCELLED_FILE).is_file()


def write_pid(run_dir: Path, pid: int) -> None:
    (run_dir / PID_FILE).write_text(str(pid))


def read_pid(run_dir: Path) -> int | None:
    """The worker's pid, or None if it was never recorded or is unreadable."""
    try:
        return int((run_dir / PID_FILE).read_text().strip())
    except (OSError, ValueError):
        return None
