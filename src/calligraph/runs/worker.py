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

        model_path = Path(request.workspace) / request.model_file

        _stage(run_dir, "read", "start")
        model = calliope.read_yaml(
            str(model_path),
            scenario=request.scenario,
            override_dict=request.override_dict or None,
        )
        _stage(run_dir, "read", "done")

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

        try:
            outcome["timings"] = dict(model.runtime.timings.root)
        except AttributeError:
            pass

    except Exception as exc:
        outcome["status"] = "failed"
        outcome["error"] = f"{type(exc).__name__}: {exc}"
        outcome["traceback"] = traceback.format_exc()
        protocol.append_event(
            run_dir,
            {"t": "log", "level": "ERROR", "logger": "calligraph", "msg": str(exc)},
        )

    outcome["completed_at"] = datetime.now(timezone.utc).isoformat()
    outcome["duration_seconds"] = round(time.time() - started, 3)

    protocol.append_event(
        run_dir,
        {
            "t": "done",
            "status": outcome["status"],
            "termination_condition": outcome.get("termination_condition"),
            "error": outcome.get("error"),
        },
    )
    protocol.write_outcome(run_dir, outcome)
    return 0 if outcome["status"] == "success" else 1


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 1:
        print("usage: python -m calligraph.runs.worker <run_dir>", file=sys.stderr)
        return 2
    return run(Path(args[0]))


if __name__ == "__main__":
    raise SystemExit(main())
