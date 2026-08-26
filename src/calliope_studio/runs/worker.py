"""The child process that builds and solves a model.

Run as `python -m calliope_studio.runs.worker <run_dir>`. A module entry point rather
than a forked callable, so that it is unaffected by the server reloading and can
be terminated cleanly.

Everything this process learns is written to `events.jsonl` (see
`calliope_studio.runs.protocol`), including failures: an exception here is a normal
outcome to report, not a crash to hide.
"""

import contextlib
import logging
import os
import sys
import threading
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

from calliope_studio.runs import process, protocol
from calliope_studio.runs.stages import StageEvent, StageTracker

#: Solver output is only emitted when this logger is at DEBUG. Calliope routes
#: the solver's stdout into it via `LogWriter`, which is how CBC and Gurobi
#: iteration lines become streamable.
SOLVER_LOGGER = "calliope.backend.backend_model.<solve>"

#: Where `logging.captureWarnings` puts `warnings.warn`. A tree of its own, not
#: under `calliope`, so it needs its own handler — and Calliope raises its own
#: user-facing warnings through `warnings`, not through the logger.
WARNINGS_LOGGER = "py.warnings"

#: What captured stdout and stderr are attributed to in the log. Not a real
#: logger name — nothing in this process logs under it — but "this is the
#: solver talking" is the distinction a reader wants.
STDIO_LOGGER = "solver"

#: And at what level. DEBUG, to match the records Calliope puts on
#: `SOLVER_LOGGER` when the solver's output *does* reach it: this is the same
#: output arriving by a different route, and it must colour the same way and
#: answer the same filter, or turning the solver down would quieten CBC and
#: leave Gurobi roaring. Raw process output is not classified any finer than
#: this — stdout and stderr share one pipe, and a solver writes harmlessly to
#: both.
STDIO_LEVEL = "DEBUG"

#: How many captured stdout lines are worth putting in the event stream.
#:
#: `events.jsonl` is replayed in full to every client that connects, and held
#: line by line in the browser, so it cannot be unbounded. A Gurobi log is a few
#: hundred lines; a MILP logging every node is not. Past the cap the lines still
#: go to `run.log`, which is exactly what that file is for.
MAX_STDIO_LINES = 20_000


def _stage_event(run_dir: Path, event: StageEvent) -> None:
    protocol.append_event(
        run_dir,
        {
            "t": "stage",
            "name": event.stage,
            "status": event.status,
            "detail": event.detail,
            "at": datetime.now(timezone.utc).isoformat(),
        },
    )


class EventLogHandler(logging.Handler):
    """Forwards Calliope's log records into the run's event stream.

    Also reads them for progress: Calliope announces its own stage boundaries
    through this same logger, so the records that describe them arrive here
    anyway. See `calliope_studio.runs.stages`.

    A warning is recorded once. Building `national_scale` raises 365 of them and
    only six are distinct — the same pyparsing deprecation 81 times, the same
    xarray one 90 times — which buried Calliope's own account of the run in a
    log the user is meant to read. Deduplicated here rather than with
    `warnings.simplefilter("once")`, which by the time a solve is under way has
    been defeated by somebody's `catch_warnings` block: the filters belong to
    every library in the process, and this set belongs to us.
    """

    def __init__(self, run_dir: Path, tracker: StageTracker) -> None:
        super().__init__()
        self.run_dir = run_dir
        self.tracker = tracker
        self._warned: set[str] = set()

    def emit(self, record: logging.LogRecord) -> None:
        try:
            message = record.getMessage()
            if record.name == WARNINGS_LOGGER:
                if message in self._warned:
                    return
                self._warned.add(message)
            protocol.append_event(
                self.run_dir,
                {
                    "t": "log",
                    "level": record.levelname,
                    "logger": record.name,
                    "msg": message,
                    "at": record.created,
                },
            )
            for event in self.tracker.observe(message):
                _stage_event(self.run_dir, event)
        except Exception:  # pragma: no cover - logging must never raise
            pass


def _install_logging(run_dir: Path, tracker: StageTracker) -> None:
    """Routes Calliope's logging into the event stream.

    Deliberately does not use `calliope.set_log_verbosity`, which clears the
    logger's handlers and attaches its own to stdout.
    """
    handler = EventLogHandler(run_dir, tracker)
    calliope_logger = logging.getLogger("calliope")
    calliope_logger.addHandler(handler)
    calliope_logger.setLevel(logging.INFO)
    logging.getLogger(SOLVER_LOGGER).setLevel(logging.DEBUG)
    logging.captureWarnings(True)
    logging.getLogger(WARNINGS_LOGGER).addHandler(handler)


#: Windows standard-handle slots, for `SetStdHandle`. Ignored elsewhere.
_STD_OUTPUT_HANDLE = -11
_STD_ERROR_HANDLE = -12


def _redirect_native_stdio(write_fd: int) -> dict | None:
    """Points Windows' standard handles at the capture pipe as well as the fds.

    Returns what was there before, for `_restore_native_stdio`, or None on any
    platform where `dup2` alone is the whole story. Never raises: losing the
    solver's output to `run.log` is a degradation, and taking the run down for it
    would not be.
    """
    if os.name != "nt":
        return None
    try:
        import ctypes
        import msvcrt

        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        handle = msvcrt.get_osfhandle(write_fd)
        # Inheritable, or a spawned solver gets a handle it cannot use.
        # HANDLE_FLAG_INHERIT is 1, and the mask is the same value.
        k32.SetHandleInformation(handle, 1, 1)
        saved = {
            slot: k32.GetStdHandle(slot)
            for slot in (_STD_OUTPUT_HANDLE, _STD_ERROR_HANDLE)
        }
        for slot in saved:
            k32.SetStdHandle(slot, handle)
        return saved
    except Exception:
        return None


def _restore_native_stdio(saved: dict | None) -> None:
    """Puts the standard handles back. A no-op where there were none to save."""
    if not saved:
        return
    try:
        import ctypes

        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        for slot, handle in saved.items():
            k32.SetStdHandle(slot, handle)
    except Exception:
        pass


@contextlib.contextmanager
def _capture_stdio(run_dir: Path) -> Iterator[None]:
    """Puts everything written to stdout and stderr into the event stream.

    At file-descriptor level, which is the whole point. Calliope's Pyomo backend
    already redirects the solver's output into a logger, but it does so with
    `contextlib.redirect_stdout`, which only rebinds `sys.stdout` — and Gurobi
    writes its log from the C library straight to fd 1. So a Gurobi solve
    streamed nothing at all: its output went to the inherited stdout, into
    `run.log`, which nothing reads. The native `gurobi` backend does not redirect
    anything in the first place. Capturing the descriptor catches both, and
    anything else that ever prints.

    Lines are written through to the original descriptor as well, so `run.log`
    stays the complete backstop it is documented to be — including past
    `MAX_STDIO_LINES`, where the event stream gives up and it does not.

    **On Windows `dup2` is not enough.** It rewrites the C runtime's descriptor
    table, which covers this process's own `print` and anything else going
    through the CRT — but a native writer calls `GetStdHandle`, and so does every
    *child* process, which inherits its handles from the standard-handle slots
    rather than from fds. `SetStdHandle` is what redirects those, and the pipe's
    write end has to be made inheritable for the child to be able to use it at
    all: `os.pipe()` returns a non-inheritable handle on Windows by design. Both
    are done below; without them a Gurobi solve on Windows reaches `run.log`
    only, which is a degradation rather than a failure.
    """
    sys.stdout.flush()
    sys.stderr.flush()
    saved_out, saved_err = os.dup(1), os.dup(2)
    # Duplicated before the thread starts, so that restoring the descriptors on
    # the way out cannot close the one it is writing through.
    passthrough_fd = os.dup(saved_out)
    read_fd, write_fd = os.pipe()
    os.dup2(write_fd, 1)
    os.dup2(write_fd, 2)
    saved_handles = _redirect_native_stdio(write_fd)
    os.close(write_fd)
    # Otherwise this process's own writes sit in a block buffer until it exits,
    # fd 1 no longer being a terminal.
    sys.stdout.reconfigure(line_buffering=True)
    sys.stderr.reconfigure(line_buffering=True)

    def pump() -> None:
        emitted = 0
        with (
            os.fdopen(read_fd, "rb") as source,
            os.fdopen(passthrough_fd, "wb") as passthrough,
        ):
            for raw in source:
                passthrough.write(raw)
                passthrough.flush()
                if emitted > MAX_STDIO_LINES:
                    continue
                emitted += 1
                if emitted > MAX_STDIO_LINES:
                    text = f"[output continues in {protocol.LOG_FILE}]"
                else:
                    text = raw.decode(errors="replace").rstrip("\n")
                try:
                    protocol.append_event(
                        run_dir,
                        {
                            "t": "log",
                            "level": STDIO_LEVEL,
                            "logger": STDIO_LOGGER,
                            "msg": text,
                            "at": time.time(),
                        },
                    )
                except Exception:  # pragma: no cover - never break the solve
                    pass

    reader = threading.Thread(target=pump, daemon=True)
    reader.start()
    try:
        yield
    finally:
        sys.stdout.flush()
        sys.stderr.flush()
        # Restoring the descriptors drops the last reference to the pipe's write
        # end, which is what lets the reader see EOF and finish.
        os.dup2(saved_out, 1)
        os.dup2(saved_err, 2)
        _restore_native_stdio(saved_handles)
        os.close(saved_out)
        os.close(saved_err)
        reader.join(timeout=5)


#: Calliope's objective variable for a cost-minimising run. A 0-d scalar in
#: `model.results`, and the single number anyone comparing two runs looks at
#: first — otherwise reachable only by loading the whole `.nc` back.
OBJECTIVE_VARIABLE = "min_cost_optimisation"


def _record_diagnostics(outcome: dict, model, *, build_only: bool) -> None:
    """Adds what the run view needs beyond pass/fail: timings, solver, objective.

    Each lookup is guarded separately. These are all conveniences, and a Calliope
    version that has moved one of them must not turn a successful solve into a
    failed run.
    """
    try:
        # `CalliopeRuntime.timings` is a plain `dict[str, float]` (verified
        # against 0.7.0.dev7, `schemas/runtime_attrs_schema.py`). This used to
        # reach for a `.root` attribute that does not exist, so it raised
        # `AttributeError` on every single run and no run ever recorded timings.
        timings = model.runtime.timings
        outcome["timings"] = dict(getattr(timings, "root", timings))
    except (AttributeError, TypeError):
        pass

    try:
        outcome["solver"] = str(model.config.solve.solver)
    except AttributeError:
        pass

    if build_only:
        return
    try:
        if OBJECTIVE_VARIABLE in model.results:
            objective = model.results[OBJECTIVE_VARIABLE]
            if objective.size == 1:
                outcome["objective"] = float(objective.item())
    except (AttributeError, KeyError, TypeError, ValueError):
        pass


def _model_root(run_dir: Path, request: protocol.RunRequest) -> Path:
    """Where to read the model from: the frozen snapshot, when there is one.

    Reading the snapshot is what makes "as written" and "as solved" the same
    thing. The worker previously read the live workspace, so editing a file in the
    seconds between clicking Run and `read_yaml` produced a run whose frozen
    config was not the config that was actually solved — the one failure mode the
    whole freeze exists to prevent.

    An incomplete snapshot — a model referring to a file outside its own folder —
    is not buildable, so those deliberately fall back to the workspace rather than
    failing a run that would otherwise have worked.
    """
    manifest = protocol.read_snapshot_manifest(run_dir)
    if manifest and manifest.get("solve_from") == "snapshot":
        snapshot = run_dir / protocol.SNAPSHOT_DIR
        if (snapshot / request.model_file).is_file():
            return snapshot
    return Path(request.workspace)


def _execute(
    run_dir: Path,
    request: protocol.RunRequest,
    outcome: dict,
    tracker: StageTracker,
    cancelled: threading.Event | None = None,
) -> None:
    """Reads, builds, solves and saves, recording what happened into `outcome`.

    Stages go through `tracker` rather than straight into the event stream, so
    that the boundaries announced here and the finer ones Calliope announces
    through the log are one ordered account of the run instead of two.
    """

    def stage(name: str, status: str) -> None:
        # Checked at the boundary rather than continuously: this is where the
        # worker is between two pieces of work and so is safe to abandon.
        if cancelled is not None and cancelled.is_set():
            raise _Cancelled()
        for event in tracker.announce(name, status):
            _stage_event(run_dir, event)

    import calliope

    root = _model_root(run_dir, request)
    outcome["solved_from"] = (
        "snapshot" if root != Path(request.workspace) else "workspace"
    )
    model_path = root / request.model_file

    stage("preprocess", "start")
    model = calliope.read_yaml(
        str(model_path),
        scenario=request.scenario,
        override_dict=request.override_dict or None,
    )
    stage("preprocess", "done")

    if request.init_only:
        # Resolution: hand the model back as Calliope understands it and stop.
        # No `build()` — the math is irrelevant to what the definition *means*,
        # and skipping it is the difference between 4 seconds and rather more
        # on a real model.
        stage("save", "start")
        model.to_netcdf(str(run_dir / protocol.RESOLVED_FILE))
        stage("save", "done")
        outcome["status"] = "success"
        outcome["termination_condition"] = "not_solved"
        _record_diagnostics(outcome, model, build_only=True)
        return

    if request.math_only:
        # Rendering math is a `build` in the only sense that matters here — it
        # parses every expression and every `where` — but it builds Calliope's
        # LaTeX backend rather than a solver problem, so `model.build()` is not
        # called and no Pyomo model is ever constructed.
        from calliope_studio.runs import mathcache, mathdoc

        stage("build", "start")
        mathdoc.write(model, run_dir / protocol.MATH_FILE)
        # Beside the payload rather than inside it: the key describes the
        # rendering, and the payload is the answer the browser reads.
        (run_dir / protocol.MATH_KEY_FILE).write_text(mathcache.fingerprint(model))
        stage("build", "done")
        outcome["status"] = "success"
        outcome["termination_condition"] = "not_solved"
        _record_diagnostics(outcome, model, build_only=True)
        return

    stage("build", "start")
    model.build()
    stage("build", "done")

    if request.build_only:
        # Used by the "validate" tier: assembling the problem exercises all
        # of the math without needing a solver.
        outcome["status"] = "success"
        outcome["termination_condition"] = "not_solved"
    else:
        stage("solve", "start")
        model.solve()
        # Calliope announces the end of the solver and the end of postprocessing
        # itself, and by here it already has. These are the safety net for the
        # day it stops: without them a wording change would leave a finished run
        # displaying "solving" for ever. `announce` drops whichever of them the
        # log already reported.
        stage("solve", "done")
        stage("postprocess", "done")

        condition = str(getattr(model.runtime, "termination_condition", "unknown"))
        outcome["termination_condition"] = condition

        stage("save", "start")
        model.to_netcdf(str(run_dir / protocol.RESULTS_FILE))
        stage("save", "done")

        # A model that solved but was found infeasible is a legitimate,
        # informative result, not an error — but it is not a success either,
        # and the UI must not offer results that do not exist.
        outcome["status"] = "success" if condition == "optimal" else "infeasible"

    _record_diagnostics(outcome, model, build_only=request.build_only)


#: The worker's membership of its killable group, held for the process's whole
#: life. See `main`.
_GROUP_HANDLE: object | None = None


class _Cancelled(Exception):
    """Raised at a stage boundary when the parent has asked the run to stop.

    Not an error: it is how a cancel becomes an orderly return rather than a
    process disappearing mid-write. Caught in `run`.
    """


#: How often the worker looks for the cancellation marker.
#:
#: A `stat` twice a second, which is nothing beside a solve. It exists because
#: there is no graceful kill on Windows — a job is terminated outright — so
#: without it a cancel during preprocess or build, which is where most cancels
#: land, would lose whatever the worker was part-way through writing. It runs on
#: POSIX too, so the two platforms behave the same rather than differing in a way
#: only one developer's machine would ever show.
CANCEL_POLL_INTERVAL = 0.5


def _watch_for_cancellation(run_dir: Path) -> threading.Event:
    """Starts a daemon thread that notices the cancellation marker.

    Returns the event it sets, so the run can stop at a boundary of its own
    choosing rather than wherever the signal happened to land. The thread is a
    daemon because the marker may never appear, and a run that completes
    normally must not wait for a poll to notice nothing.
    """
    cancelled = threading.Event()

    def poll() -> None:
        while not cancelled.is_set():
            if protocol.is_cancelled(run_dir):
                cancelled.set()
                return
            time.sleep(CANCEL_POLL_INTERVAL)

    threading.Thread(target=poll, daemon=True).start()
    return cancelled


def run(run_dir: Path) -> int:
    """Executes the run described by `run_dir/request.json`.

    Returns:
        A process exit code: 0 if a solution was found, 1 otherwise.
    """
    started = time.time()
    request = protocol.RunRequest.read(run_dir)
    tracker = StageTracker()
    _install_logging(run_dir, tracker)
    cancelled = _watch_for_cancellation(run_dir)

    outcome: dict = {
        "started_at": datetime.now(timezone.utc).isoformat(),
        "status": "failed",
    }

    try:
        # The capture ends before the terminal event is written: a client stops
        # reading at `done`, so anything the pump were still draining after it
        # would never be delivered.
        with _capture_stdio(run_dir):
            _execute(run_dir, request, outcome, tracker, cancelled)
    except _Cancelled:
        # The parent has already written the cancellation marker, and `manager.get`
        # reads the status off that rather than off here — so this exists to let
        # the outcome be written at all. Without it the kill arrives wherever it
        # arrives and the run leaves no record of how far it got.
        outcome["status"] = "cancelled"
    except Exception as exc:
        outcome["status"] = "failed"
        outcome["error"] = f"{type(exc).__name__}: {exc}"
        outcome["traceback"] = traceback.format_exc()
        protocol.append_event(
            run_dir,
            {
                "t": "log",
                "level": "ERROR",
                "logger": "calliope_studio",
                "msg": str(exc),
            },
        )
        # A results file half-written by the failing call is not a results file.
        # Left in place it makes the run report `has_results`, which mints a
        # handle, which opens the run tab on charts that then fail to load —
        # observed for real when `to_netcdf` raised while appending attributes,
        # after the model had already solved to optimality.
        (run_dir / protocol.RESULTS_FILE).unlink(missing_ok=True)
        # Same reasoning for a resolution: a half-written `resolved.nc` is not a
        # model, and the parent would load it and fail rather than fall back.
        (run_dir / protocol.RESOLVED_FILE).unlink(missing_ok=True)

    return _finish(run_dir, outcome, started)


def _finish(run_dir: Path, outcome: dict, started: float) -> int:
    """Records the terminal outcome and announces it.

    The outcome is written *before* the event that announces it. A client watching
    the log reacts to `done` within milliseconds and immediately asks for the run's
    record; with the old order that record still said "running", because nothing on
    disk yet said otherwise.
    """
    outcome["completed_at"] = datetime.now(timezone.utc).isoformat()
    outcome["duration_seconds"] = round(time.time() - started, 3)

    protocol.write_outcome(run_dir, outcome)
    protocol.append_event(
        run_dir,
        {
            "t": "done",
            "status": outcome["status"],
            "termination_condition": outcome.get("termination_condition"),
            "error": outcome.get("error"),
        },
    )
    return 0 if outcome["status"] == "success" else 1


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 1:
        print("usage: python -m calliope_studio.runs.worker <run_dir>", file=sys.stderr)
        return 2

    global _GROUP_HANDLE

    run_dir = Path(args[0])
    # First, before `import calliope` and therefore before anything can spawn a
    # solver: joining afterwards would leave a window in which a grandchild
    # escapes the group and survives the kill.
    #
    # Held at module level rather than in a local because it has to outlive this
    # call for the reason `process.join_group` documents: on Windows the job is
    # unlinked from the namespace when its last handle closes, and the manager
    # finds it by name.
    _GROUP_HANDLE = process.join_group(protocol.group_name(run_dir.name))

    return run(run_dir)


if __name__ == "__main__":
    raise SystemExit(main())
