"""The file layout and event format shared by the run worker and its parent.

Runs communicate through files rather than a pipe. That costs a little more code
than reading the child's stdout, and buys three things worth having:

- the server can be restarted (or reloaded in development) without losing a run
  in flight or its output;
- a finished run can be reopened and its log replayed, because it was never
  only in memory;
- Calliope's own logging setup clears handlers on the `calliope` logger and
  attaches its own to stdout, so stdout is not ours to define a protocol on.

Layout under `{workspace}/.calligraph/runs/{run_id}/`:

    request.json    what to run; written by the parent before starting
    events.jsonl    the structured event stream; appended by the worker
    run.log         raw child stdout/stderr, a debugging backstop
    outcome.json    terminal status; written by the worker as its last act
    results.nc      the solved model
"""

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator

REQUEST_FILE = "request.json"
EVENTS_FILE = "events.jsonl"
LOG_FILE = "run.log"
OUTCOME_FILE = "outcome.json"
RESULTS_FILE = "results.nc"

#: Ordered stages a run passes through, for the frontend's progress display.
STAGES = ("read", "build", "solve", "save")


@dataclass(frozen=True)
class RunRequest:
    """What the worker should run."""

    workspace: str
    model_file: str = "model.yaml"
    scenario: str | None = None
    override_dict: dict = field(default_factory=dict)
    build_only: bool = False

    def write(self, run_dir: Path) -> None:
        (run_dir / REQUEST_FILE).write_text(json.dumps(self.__dict__, indent=2))

    @classmethod
    def read(cls, run_dir: Path) -> "RunRequest":
        return cls(**json.loads((run_dir / REQUEST_FILE).read_text()))


def append_event(run_dir: Path, event: dict) -> None:
    """Appends one event, flushed, so a reader tailing the file sees it promptly."""
    with open(run_dir / EVENTS_FILE, "a") as fh:
        fh.write(json.dumps(event, default=str) + "\n")
        fh.flush()


def read_events(run_dir: Path) -> Iterator[dict]:
    """Replays the events written so far, skipping any partial trailing line."""
    path = run_dir / EVENTS_FILE
    if not path.is_file():
        return
    with open(path) as fh:
        for line in fh:
            if not line.endswith("\n"):
                break  # a partially written line; the next poll will see it whole
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def read_outcome(run_dir: Path) -> dict[str, Any] | None:
    """The terminal outcome, or None if the run has not finished."""
    path = run_dir / OUTCOME_FILE
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError:
        return None


def write_outcome(run_dir: Path, outcome: dict) -> None:
    (run_dir / OUTCOME_FILE).write_text(json.dumps(outcome, indent=2, default=str))
