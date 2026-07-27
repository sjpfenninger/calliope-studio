"""Where a run has got to, in Calliope's terms rather than in ours.

Calliope already reports its own progress. `log_time` writes an entry into
`model.runtime.timings` *and* logs a comment at INFO on the way past, so the
boundaries between preprocessing, the backend build, the solver itself and
postprocessing are all announced on a logger the worker is already listening to.
This module reads them back off.

The worker announces four boundaries of its own — it is the only thing that
knows when `read_yaml` was called and when `to_netcdf` finished — but those are
*its* boundaries, and the one that matters is useless: everything from the first
constraint to the last postprocessed variable is a single `solve` step, which on
a real model is the only step long enough to want progress for. Splitting it
needs Calliope's own account of what it is doing.

Matching on log text is fragile, and the alternative is not obviously better:
polling `model.runtime.timings` from a thread reads keys that are just as much
an internal detail, and needs a model object that does not exist until
`read_yaml` has already passed two of the transitions. So the fragility is
contained instead. A marker that stops matching costs the *refinement*, never
the backbone: the run keeps showing the coarse stage the worker announced
itself, which is exactly what it showed before this module existed. Nothing here
can report a stage that did not happen, and `StageTracker` will not let one be
reported out of order.
"""

import re
import threading
from dataclasses import dataclass
from typing import Sequence

from calliope_studio.runs import protocol


@dataclass(frozen=True)
class StageEvent:
    """One transition to announce, or a change of detail within the current one."""

    stage: str
    status: str
    detail: str | None = None


#: A distinctive substring of one of Calliope's `log_time` comments, and the
#: transitions it announces. Substrings rather than whole messages: several carry
#: a formatted suffix (`". Time since start of solving optimisation problem: …"`)
#: and one is parameterised by the run mode.
#:
#: `solver_exit` announces two things at once. Calliope goes straight from the
#: solver returning into postprocessing with nothing logged in between, so the
#: end of one *is* the start of the other.
MARKERS: tuple[tuple[str, tuple[tuple[str, str], ...]], ...] = (
    ("Model: preprocessing data", (("preprocess", "start"),)),
    ("Model: initialisation complete", (("preprocess", "done"),)),
    ("Model: backend build starting", (("build", "start"),)),
    ("Model: backend build complete", (("build", "done"),)),
    ("starting model in", (("solve", "start"),)),
    ("Backend: solver finished running", (("solve", "done"), ("postprocess", "start"))),
    ("Postprocessing: ended", (("postprocess", "done"),)),
    ("Backend: model solve completed", (("postprocess", "done"),)),
)

#: What the current stage is busy with, when Calliope says. Two shapes are worth
#: catching: the six component groups of a backend build, which is the part that
#: takes minutes on a large model and otherwise reports nothing at all until it
#: is over; and the per-iteration lines of operate and SPORES modes, where a
#: single `solve` is really many.
DETAIL_PATTERNS: tuple[re.Pattern[str], ...] = (
    # "Optimisation Model | constraints | Generated."
    re.compile(r"Optimisation Model \| ([^|]+?) \| Generated\."),
    # "Optimisation model | Running time window starting at 2005-01-05 00:00."
    # "Optimisation model | Running SPORE 3."
    re.compile(r"Optimisation model \| (Running [^|]+?)\.?\s*$"),
)

#: Ranks a status within its stage, so that a stage and its status together give
#: one monotonically increasing position through the run.
_STATUS_RANK = {"start": 0, "done": 1}


def transitions_for(message: str) -> tuple[tuple[str, str], ...]:
    """The `(stage, status)` transitions a log message announces, if any."""
    for marker, transitions in MARKERS:
        if marker in message:
            return transitions
    return ()


def detail_for(message: str) -> str | None:
    """What the current stage is working on, if the message says."""
    for pattern in DETAIL_PATTERNS:
        match = pattern.search(message)
        if match:
            return match.group(1).strip()
    return None


class StageTracker:
    """Keeps a run's progress moving forwards, and only forwards.

    Every stage transition goes through here, whether the worker announced it or
    a log message did, so there is one account of where the run is rather than
    two racing each other. A transition that would move backwards is dropped: the
    worker deliberately re-announces the end of a stage that the log may already
    have reported, so that a marker which stops matching degrades to the coarse
    behaviour instead of leaving the display stuck, and without this guard that
    safety net would itself make the display jump.

    Locked, because the log handler runs wherever Calliope happens to be and the
    worker's own announcements come from its main thread.
    """

    def __init__(self, stages: Sequence[str] = protocol.STAGES) -> None:
        self._order = {name: index for index, name in enumerate(stages)}
        self._lock = threading.Lock()
        #: The furthest point reached, as `(stage index, status rank)`.
        self._position = (-1, -1)
        self._stage: str | None = None
        self._status: str | None = None

    @property
    def stage(self) -> str | None:
        """The stage the run is in, or None before the first transition."""
        return self._stage

    def announce(self, stage: str, status: str) -> list[StageEvent]:
        """Records a transition the worker knows about first-hand."""
        with self._lock:
            return self._advance(stage, status)

    def observe(self, message: str) -> list[StageEvent]:
        """Reads whatever a Calliope log message says about progress."""
        with self._lock:
            events: list[StageEvent] = []
            for stage, status in transitions_for(message):
                events.extend(self._advance(stage, status))
            if events:
                return events

            detail = detail_for(message)
            if detail is None or self._stage is None or self._status is None:
                return []
            # Detail does not move the run on, so it deliberately skips the
            # ordering guard: it re-states the current stage with something new
            # to say about it.
            return [StageEvent(self._stage, self._status, detail)]

    def _advance(self, stage: str, status: str) -> list[StageEvent]:
        """Moves to a transition, or returns nothing if it is not ahead of us."""
        index = self._order.get(stage)
        rank = _STATUS_RANK.get(status)
        if index is None or rank is None:
            return []

        position = (index, rank)
        if position <= self._position:
            return []

        events = []
        # A stage cannot finish without having started. It can get here having
        # never done so when the marker for its start was the one that stopped
        # matching, and an event stream that says "done" for something it never
        # said had begun is not one the display can read.
        if rank == _STATUS_RANK["done"] and self._position < (index, -1):
            events.append(StageEvent(stage, "start"))
        events.append(StageEvent(stage, status))

        self._position = position
        self._stage, self._status = stage, status
        return events
