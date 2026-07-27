"""Reading a run's progress off what Calliope says it is doing.

The messages quoted here are Calliope 0.7.0.dev7's, taken from a real run's
`events.jsonl`. They are the contract this module depends on, so when one of
these tests fails the question to ask is whether Calliope changed its wording —
and the answer is only ever to update the marker, never to loosen the tracker.
"""

import pytest

from calliope_studio.runs import protocol
from calliope_studio.runs.stages import StageTracker, detail_for, transitions_for

#: One real solve, as Calliope logged it, with the noise left in.
SOLVE_MESSAGES = [
    "Model: preprocessing data",
    "Math init | loading pre-defined math.",
    "input data `color` not defined in model math; it will not be available.",
    "Model: initialisation complete",
    "Model: backend build starting",
    "Optimisation Model | parameters/lookups | Generated.",
    "Optimisation Model | variables | Generated.",
    "Optimisation Model | constraints | Generated.",
    "Optimisation Model | objectives | Generated.",
    "Model: backend build complete",
    "Optimisation model | starting model in base mode.",
    "Welcome to the CBC MILP Solver",
    "Backend: solver finished running. Time since start of solving optimisation "
    "problem: 0:02:38.963897",
    "Postprocessing: applied zero threshold 1e-10 to model results.",
    "Postprocessing: ended. Time since start of solving optimisation problem: "
    "0:02:39.014849",
    "Backend: model solve completed. Time since start of solving optimisation "
    "problem: 0:02:39.015076",
]


def replay(messages, tracker=None):
    """The transitions a tracker announces over a sequence of log messages."""
    tracker = tracker or StageTracker()
    return [
        (event.stage, event.status)
        for message in messages
        for event in tracker.observe(message)
        if event.detail is None
    ]


class TestReadingCalliopesMessages:
    def test_a_whole_solve_gives_every_stage_in_order(self):
        assert replay(SOLVE_MESSAGES) == [
            ("preprocess", "start"),
            ("preprocess", "done"),
            ("build", "start"),
            ("build", "done"),
            ("solve", "start"),
            ("solve", "done"),
            ("postprocess", "start"),
            ("postprocess", "done"),
        ]

    def test_the_solver_finishing_also_starts_postprocessing(self):
        """Calliope logs nothing between the two, so one message means both."""
        assert transitions_for("Backend: solver finished running") == (
            ("solve", "done"),
            ("postprocess", "start"),
        )

    def test_an_unremarkable_message_says_nothing(self):
        assert transitions_for("Math init | loading pre-defined math.") == ()
        assert (
            replay(["Welcome to the CBC MILP Solver", "Set parameter Username"]) == []
        )

    @pytest.mark.parametrize(
        ("message", "expected"),
        [
            ("Optimisation Model | constraints | Generated.", "constraints"),
            (
                "Optimisation Model | parameters/lookups | Generated.",
                "parameters/lookups",
            ),
            ("Optimisation model | Running SPORE 3.", "Running SPORE 3"),
            (
                "Optimisation model | Running time window starting at 2005-01-05 00:00.",
                "Running time window starting at 2005-01-05 00:00",
            ),
            # The one that announces the stage itself, rather than its detail.
            ("Optimisation model | starting model in base mode.", None),
            ("Model: backend build complete", None),
        ],
    )
    def test_detail_is_what_the_stage_is_working_on(self, message, expected):
        assert detail_for(message) == expected

    def test_detail_re_states_the_stage_it_belongs_to(self):
        tracker = StageTracker()
        tracker.announce("build", "start")
        (event,) = tracker.observe("Optimisation Model | constraints | Generated.")
        assert (event.stage, event.status, event.detail) == (
            "build",
            "start",
            "constraints",
        )

    def test_detail_before_any_stage_is_dropped(self):
        """There is nothing for it to be a detail *of*."""
        assert (
            StageTracker().observe("Optimisation Model | variables | Generated.") == []
        )


class TestProgressOnlyMovesForwards:
    def test_a_repeated_transition_is_announced_once(self):
        """Two of Calliope's messages mean the end of postprocessing."""
        tracker = StageTracker()
        replay(SOLVE_MESSAGES, tracker)
        assert tracker.announce("postprocess", "done") == []
        assert tracker.stage == "postprocess"

    def test_the_workers_safety_net_is_silent_when_the_log_did_its_job(self):
        """The worker re-announces what Calliope has already reported.

        It has to: a marker that stops matching would otherwise leave a finished
        run displaying "solving" for ever. The cost of that safety net is that
        it must be free when it is not needed.
        """
        tracker = StageTracker()
        replay(SOLVE_MESSAGES, tracker)
        assert tracker.announce("solve", "done") == []
        assert tracker.announce("postprocess", "done") == []

    def test_the_safety_net_completes_a_run_the_log_went_quiet_on(self):
        """With no markers matching at all, the coarse account still holds."""
        tracker = StageTracker()
        announced = [
            (event.stage, event.status)
            for stage, status in [
                ("preprocess", "start"),
                ("preprocess", "done"),
                ("build", "start"),
                ("build", "done"),
                ("solve", "start"),
                ("solve", "done"),
                ("postprocess", "done"),
                ("save", "start"),
                ("save", "done"),
            ]
            for event in tracker.announce(stage, status)
        ]
        # `postprocess` is completed without ever having been started, so its
        # start is supplied: an event stream that ends a stage it never began is
        # not one a progress display can read.
        assert ("postprocess", "start") in announced
        assert announced.index(("postprocess", "start")) < announced.index(
            ("postprocess", "done")
        )

    def test_a_skipped_stage_is_not_invented(self):
        """An `init_only` run goes straight from reading to saving."""
        tracker = StageTracker()
        announced = [
            (event.stage, event.status)
            for stage, status in [
                ("preprocess", "start"),
                ("preprocess", "done"),
                ("save", "start"),
                ("save", "done"),
            ]
            for event in tracker.announce(stage, status)
        ]
        assert announced == [
            ("preprocess", "start"),
            ("preprocess", "done"),
            ("save", "start"),
            ("save", "done"),
        ]

    def test_an_unknown_stage_or_status_is_ignored(self):
        tracker = StageTracker()
        assert tracker.announce("teleport", "start") == []
        assert tracker.announce("build", "sideways") == []
        assert tracker.stage is None

    def test_the_stages_are_the_ones_the_protocol_declares(self):
        """The frontend mirrors `STAGES`, so the tracker must not know others."""
        tracker = StageTracker()
        for stage in protocol.STAGES:
            assert tracker.announce(stage, "start")
