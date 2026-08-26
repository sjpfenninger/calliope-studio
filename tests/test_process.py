"""Killing a run means killing the solver, not just the worker.

The whole reason `runs/process.py` exists is the *grandchild*: Calliope has no
interrupt API, so cancelling is killing, and what is actually burning a core is
the solver the worker started. A cancel that terminates only the direct child
leaves that solver running with nothing left to reap it.

`test_cancelling_stops_the_run` in `test_runs.py` could not catch that — it polls
`Popen.poll()` on the worker alone, so it passes just as happily against a plain
`TerminateProcess`. These tests are what pin the requirement down, and they are
written for POSIX as much as for Windows: the two platforms reach it by entirely
different mechanisms (a session and a signal; a job object) and the assertion is
the only thing they share.
"""

import sys
import textwrap
import time

import pytest

from calliope_studio.runs import process, protocol

#: Announces its own child's pid, then outlives any reasonable test. Both halves
#: sleep far longer than the deadline below, so anything that exits did so
#: because it was killed.
SPAWNER = textwrap.dedent("""
    import subprocess, sys, time
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(300)"])
    print(child.pid, flush=True)
    time.sleep(300)
""")


def _wait_until(predicate, timeout=15.0):
    """Polls until true. Never a fixed sleep: a guessed delay is wrong twice."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return predicate()


@pytest.fixture
def spawned(tmp_path):
    """A worker stand-in with a live grandchild, cleaned up however the test ends."""
    log_path = tmp_path / "run.log"
    with open(log_path, "w") as log_file:
        child = process.spawn([sys.executable, "-c", SPAWNER], log_file=log_file)

    def grandchild_pid():
        text = log_path.read_text().strip()
        return int(text.split()[0]) if text else None

    assert _wait_until(lambda: grandchild_pid() is not None), "no grandchild announced"
    grandchild = grandchild_pid()
    assert process.is_running(grandchild)

    yield child, grandchild

    # Belt and braces: a failed assertion must not leak two sleeping processes.
    process.kill_group(child.pid)
    child.poll()


class TestTheWholeGroupDies:
    def test_terminating_the_group_takes_the_grandchild_with_it(self, spawned):
        """The solver is a grandchild, and it is the thing that must stop."""
        child, grandchild = spawned

        assert process.terminate_group(child.pid)

        assert _wait_until(lambda: child.poll() is not None), "worker survived"
        assert _wait_until(lambda: not process.is_running(grandchild)), (
            "the solver stand-in outlived the worker — this is the orphaned-solver "
            "case the process group exists for"
        )

    def test_killing_an_already_dead_group_is_not_an_error(self, spawned):
        """Cancelling twice, or cancelling a run that just finished, is ordinary."""
        child, _ = spawned
        process.terminate_group(child.pid)
        assert _wait_until(lambda: child.poll() is not None)

        # False rather than an exception: the caller's job is to stop it, and it
        # has stopped.
        process.kill_group(child.pid)


class TestLiveness:
    def test_a_live_process_reads_as_running(self, spawned):
        child, _ = spawned
        assert process.is_running(child.pid)

    def test_a_finished_process_does_not(self, tmp_path):
        """A worker that exited on its own must not read as still running.

        `subprocess.run` waits and reaps, so by the time it returns the pid is
        genuinely gone rather than a zombie — which `os.kill(pid, 0)` would
        happily report as alive.
        """
        with open(tmp_path / "out.log", "w") as log_file:
            child = process.spawn([sys.executable, "-c", ""], log_file=log_file)
        child.wait()

        assert not process.is_running(child.pid)


class TestGroupNaming:
    def test_a_name_is_derived_from_the_run_id(self):
        """Derived rather than stored: a restarted server never created it."""
        run_id = "11111111-2222-3333-4444-555555555555"

        assert protocol.group_name(run_id) == f"calliope-studio-run-{run_id}"

    def test_the_same_run_always_gets_the_same_name(self):
        """It is looked up by name after a restart, so it cannot be random."""
        run_id = "11111111-2222-3333-4444-555555555555"

        assert protocol.group_name(run_id) == protocol.group_name(run_id)
