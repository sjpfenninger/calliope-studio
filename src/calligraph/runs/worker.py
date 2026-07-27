"""The child process that builds and solves a model.

Run as `python -m calligraph.runs.worker <run_dir>`. A module entry point rather
than a forked callable, so that it is unaffected by the server reloading and can
be terminated cleanly.

Everything this process learns is written to `events.jsonl` (see
`calligraph.runs.protocol`), including failures: an exception here is a normal
outcome to report, not a crash to hide.
"""

import logging
import sys
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path

from calligraph.runs import protocol

#: Solver output is only emitted when this logger is at DEBUG. Calliope routes
#: the solver's stdout into it via `LogWriter`, which is how CBC and Gurobi
#: iteration lines become streamable.
SOLVER_LOGGER = "calliope.backend.backend_model.<solve>"


class EventLogHandler(logging.Handler):
    """Forwards Calliope's log records into the run's event stream."""

    def __init__(self, run_dir: Path) -> None:
        super().__init__()
        self.run_dir = run_dir

    def emit(self, record: logging.LogRecord) -> None:
        try:
            protocol.append_event(
                self.run_dir,
                {
                    "t": "log",
                    "level": record.levelname,
                    "logger": record.name,
                    "msg": record.getMessage(),
                    "at": record.created,
                },
            )
        except Exception:  # pragma: no cover - logging must never raise
            pass


def _stage(run_dir: Path, name: str, status: str) -> None:
    protocol.append_event(
        run_dir,
        {
            "t": "stage",
            "name": name,
            "status": status,
            "at": datetime.now(timezone.utc).isoformat(),
        },
    )


def _install_logging(run_dir: Path) -> None:
    """Routes Calliope's logging into the event stream.

    Deliberately does not use `calliope.set_log_verbosity`, which clears the
    logger's handlers and attaches its own to stdout.
    """
    handler = EventLogHandler(run_dir)
    calliope_logger = logging.getLogger("calliope")
    calliope_logger.addHandler(handler)
    calliope_logger.setLevel(logging.INFO)
    logging.getLogger(SOLVER_LOGGER).setLevel(logging.DEBUG)
    logging.captureWarnings(True)
    logging.getLogger("py.warnings").addHandler(handler)


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


def run(run_dir: Path) -> int:
    """Executes the run described by `run_dir/request.json`.

    Returns:
        A process exit code: 0 if a solution was found, 1 otherwise.
    """
    started = time.time()
    request = protocol.RunRequest.read(run_dir)
    _install_logging(run_dir)

    outcome: dict = {
        "started_at": datetime.now(timezone.utc).isoformat(),
        "status": "failed",
    }

    try:
        import calliope

        root = _model_root(run_dir, request)
        outcome["solved_from"] = (
            "snapshot" if root != Path(request.workspace) else "workspace"
        )
        model_path = root / request.model_file

        _stage(run_dir, "read", "start")
        model = calliope.read_yaml(
            str(model_path),
            scenario=request.scenario,
            override_dict=request.override_dict or None,
        )
        _stage(run_dir, "read", "done")

        if request.init_only:
            # Resolution: hand the model back as Calliope understands it and stop.
            # No `build()` — the math is irrelevant to what the definition *means*,
            # and skipping it is the difference between 4 seconds and rather more
            # on a real model.
            _stage(run_dir, "save", "start")
            model.to_netcdf(str(run_dir / protocol.RESOLVED_FILE))
            _stage(run_dir, "save", "done")
            outcome["status"] = "success"
            outcome["termination_condition"] = "not_solved"
            _record_diagnostics(outcome, model, build_only=True)
            return _finish(run_dir, outcome, started)

        _stage(run_dir, "build", "start")
        model.build()
        _stage(run_dir, "build", "done")

        if request.build_only:
            # Used by the "validate" tier: assembling the problem exercises all
            # of the math without needing a solver.
            outcome["status"] = "success"
            outcome["termination_condition"] = "not_solved"
        else:
            _stage(run_dir, "solve", "start")
            model.solve()
            _stage(run_dir, "solve", "done")

            condition = str(getattr(model.runtime, "termination_condition", "unknown"))
            outcome["termination_condition"] = condition

            _stage(run_dir, "save", "start")
            model.to_netcdf(str(run_dir / protocol.RESULTS_FILE))
            _stage(run_dir, "save", "done")

            # A model that solved but was found infeasible is a legitimate,
            # informative result, not an error — but it is not a success either,
            # and the UI must not offer results that do not exist.
            outcome["status"] = "success" if condition == "optimal" else "infeasible"

        _record_diagnostics(outcome, model, build_only=request.build_only)

    except Exception as exc:
        outcome["status"] = "failed"
        outcome["error"] = f"{type(exc).__name__}: {exc}"
        outcome["traceback"] = traceback.format_exc()
        protocol.append_event(
            run_dir,
            {"t": "log", "level": "ERROR", "logger": "calligraph", "msg": str(exc)},
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
        print("usage: python -m calligraph.runs.worker <run_dir>", file=sys.stderr)
        return 2
    return run(Path(args[0]))


if __name__ == "__main__":
    raise SystemExit(main())
