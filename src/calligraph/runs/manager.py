"""Starting, watching and cancelling runs.

The parent side of the run protocol. Run status is *derived* from what is on
disk rather than stored in memory, so that restarting the server — which happens
constantly under `--reload` — does not lose track of what happened.
"""

import asyncio
import os
import signal
import subprocess
import sys
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import AsyncIterator

from calligraph.runs import protocol

#: How often the event tailer looks for new lines. Fast enough to feel live,
#: slow enough not to spin a core on a long solve.
POLL_INTERVAL = 0.25

TERMINAL_STATUSES = frozenset({"success", "infeasible", "failed", "cancelled"})


@dataclass(frozen=True)
class RunRecord:
    """A run's current state, as far as the filesystem knows."""

    id: str
    status: str
    created_at: str
    started_at: str | None = None
    completed_at: str | None = None
    termination_condition: str | None = None
    error: str | None = None
    has_results: bool = False

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "status": self.status,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "completed_at": self.completed_at,
            "termination_condition": self.termination_condition,
            "error": self.error,
            "has_results": self.has_results,
        }


class RunManager:
    """Owns the child processes and the mapping from run id to directory."""

    def __init__(self) -> None:
        self._processes: dict[str, subprocess.Popen] = {}
        self._dirs: dict[str, Path] = {}
        self._cancelled: set[str] = set()

    # -- lookup -----------------------------------------------------------

    def register_dir(self, run_id: str, run_dir: Path) -> None:
        self._dirs[run_id] = run_dir

    def run_dir(self, run_id: str) -> Path:
        try:
            return self._dirs[run_id]
        except KeyError:
            raise KeyError(run_id) from None

    def discover(self, runs_root: Path) -> list[RunRecord]:
        """Finds runs already on disk, newest first, so history survives a restart.

        Ordered by when each run was requested, not by directory name: the names
        are UUIDs, so sorting them puts the history in an arbitrary order that
        merely looks deliberate.
        """
        directories = [
            directory
            for directory in runs_root.glob("*/")
            if (directory / protocol.REQUEST_FILE).is_file()
        ]
        directories.sort(
            key=lambda directory: (directory / protocol.REQUEST_FILE).stat().st_mtime,
            reverse=True,
        )

        records = []
        for directory in directories:
            self._dirs.setdefault(directory.name, directory)
            records.append(self.get(directory.name))
        return records

    # -- lifecycle --------------------------------------------------------

    def start(self, runs_root: Path, request: protocol.RunRequest) -> RunRecord:
        """Starts a run in a fresh directory and returns immediately."""
        run_id = str(uuid.uuid4())
        run_dir = runs_root / run_id
        run_dir.mkdir(parents=True, exist_ok=True)
        request.write(run_dir)
        self.register_dir(run_id, run_dir)

        log_file = open(run_dir / protocol.LOG_FILE, "w")
        process = subprocess.Popen(
            [sys.executable, "-m", "calligraph.runs.worker", str(run_dir)],
            stdout=log_file,
            stderr=subprocess.STDOUT,
            # Its own process group, so cancelling kills the solver too rather
            # than leaving it orphaned and still burning CPU.
            start_new_session=True,
        )
        self._processes[run_id] = process
        return self.get(run_id)

    def get(self, run_id: str) -> RunRecord:
        """Derives a run's state from its directory and any live process."""
        run_dir = self.run_dir(run_id)
        # From the request file, which is written once and never touched again.
        # The directory's own timestamp moves every time the worker appends an
        # event, which made a finished run look as though it was created after
        # it started.
        created_at = datetime.fromtimestamp(
            (run_dir / protocol.REQUEST_FILE).stat().st_mtime, tz=timezone.utc
        ).isoformat()
        has_results = (run_dir / protocol.RESULTS_FILE).is_file()

        outcome = protocol.read_outcome(run_dir)
        if outcome is not None:
            status = outcome.get("status", "failed")
            if run_id in self._cancelled:
                status = "cancelled"
            return RunRecord(
                id=run_id,
                status=status,
                created_at=created_at,
                started_at=outcome.get("started_at"),
                completed_at=outcome.get("completed_at"),
                termination_condition=outcome.get("termination_condition"),
                error=outcome.get("error"),
                has_results=has_results,
            )

        if run_id in self._cancelled:
            return RunRecord(
                id=run_id,
                status="cancelled",
                created_at=created_at,
                has_results=has_results,
            )

        process = self._processes.get(run_id)
        if process is not None and process.poll() is None:
            return RunRecord(
                id=run_id,
                status="running",
                created_at=created_at,
                has_results=has_results,
            )

        # No outcome file and no live process: either the worker died hard, or
        # the server restarted while it was running and we can no longer watch
        # it. Reporting "failed" is honest; claiming "running" would hang the UI.
        return RunRecord(
            id=run_id,
            status="failed",
            created_at=created_at,
            error="Run did not complete; the process is no longer present.",
            has_results=has_results,
        )

    async def cancel(self, run_id: str) -> None:
        """Terminates a run.

        Calliope offers no interrupt API — no timeout, no solver callback, no
        `KeyboardInterrupt` handling — so killing the process group is the only
        way to stop a solve.
        """
        self._cancelled.add(run_id)
        process = self._processes.get(run_id)
        if process is None or process.poll() is not None:
            return

        os.killpg(os.getpgid(process.pid), signal.SIGTERM)
        for _ in range(20):  # up to ~5s for a graceful exit
            await asyncio.sleep(0.25)
            if process.poll() is not None:
                return
        os.killpg(os.getpgid(process.pid), signal.SIGKILL)

    # -- streaming --------------------------------------------------------

    async def stream(self, run_id: str) -> AsyncIterator[dict]:
        """Yields the run's events, replaying history then following live ones.

        Replaying from the start means a client that connects late, or
        reconnects, still sees the whole log.
        """
        run_dir = self.run_dir(run_id)
        seen = 0

        while True:
            events = list(protocol.read_events(run_dir))
            for event in events[seen:]:
                yield event
            seen = len(events)

            if any(event.get("t") == "done" for event in events):
                return
            if self.get(run_id).status in TERMINAL_STATUSES:
                # Terminal without a `done` event: the worker was killed. Say so
                # rather than streaming forever.
                yield {"t": "done", "status": self.get(run_id).status}
                return

            await asyncio.sleep(POLL_INTERVAL)
