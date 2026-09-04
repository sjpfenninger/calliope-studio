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

import signal
import sys
import textwrap
import time

import pytest

from calliope_studio.runs import process, protocol

#: Joins the killable group, announces its own child's pid, then outlives any
#: reasonable test. Both halves sleep far longer than the deadline below, so
#: anything that exits did so because it was killed.
#:
#: **The `join_group` call is not ceremony.** On POSIX the group exists because
#: the *parent* passed `start_new_session`, so a stand-in that ignored it would
#: still be killed as a group and the test would pass. On Windows there is no
#: such thing: the job object exists only if the child creates and joins one,
#: exactly as `worker.main` does before importing Calliope. Without this the
#: test asserted something the platform cannot deliver — which is what CI on
#: Windows reported, and it was the test that was wrong.
SPAWNER = textwrap.dedent("""
    import subprocess, sys, time
    from calliope_studio.runs import process
    handle = process.join_group(sys.argv[1])
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(300)"])
    print(child.pid, flush=True)
    time.sleep(300)
""")

#: The group these stand-ins join. A fixed name rather than a run id: nothing
#: here is a run, and `protocol.group_name` is tested separately.
GROUP = "calliope-studio-test-group"


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
        child = process.spawn([sys.executable, "-c", SPAWNER, GROUP], log_file=log_file)

    def grandchild_pid():
        text = log_path.read_text().strip()
        return int(text.split()[0]) if text else None

    assert _wait_until(lambda: grandchild_pid() is not None), "no grandchild announced"
    grandchild = grandchild_pid()
    assert process.is_running(grandchild)

    yield child, grandchild

    # Belt and braces: a failed assertion must not leak two sleeping processes.
    process.kill_group(child.pid, GROUP)
    child.poll()


class TestTheWholeGroupDies:
    def test_terminating_the_group_takes_the_grandchild_with_it(self, spawned):
        """The solver is a grandchild, and it is the thing that must stop."""
        child, grandchild = spawned

        assert process.terminate_group(child.pid, GROUP)

        assert _wait_until(lambda: child.poll() is not None), "worker survived"
        assert _wait_until(lambda: not process.is_running(grandchild)), (
            "the solver stand-in outlived the worker — this is the orphaned-solver "
            "case the process group exists for"
        )

    def test_killing_an_already_dead_group_is_not_an_error(self, spawned):
        """Cancelling twice, or cancelling a run that just finished, is ordinary."""
        child, _ = spawned
        process.terminate_group(child.pid, GROUP)
        assert _wait_until(lambda: child.poll() is not None)

        # False rather than an exception: the caller's job is to stop it, and it
        # has stopped.
        process.kill_group(child.pid, GROUP)


class TestSignalGroup:
    def test_a_signal_reaches_the_grandchild(self, spawned):
        """`signal_group` is what both tiers of the kill are built on.

        The solver is a grandchild, so a signal that stopped at the worker's own
        pid would leave it running — which is what a plain `terminate()` does.
        """
        child, grandchild = spawned

        assert process.signal_group(child.pid, signal.SIGTERM)

        assert _wait_until(lambda: child.poll() is not None), "worker survived"
        assert _wait_until(lambda: not process.is_running(grandchild)), (
            "the grandchild outlived a group signal"
        )

    def test_signalling_a_group_that_is_gone_is_false_not_an_error(self, spawned):
        child, _ = spawned
        process.kill_group(child.pid, GROUP)
        assert _wait_until(lambda: child.poll() is not None)
        assert process.signal_group(child.pid, signal.SIGTERM) is False


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


class TestTheWindowsBindingsAreDeclared:
    """Every kernel32 call must have argument and return types declared.

    This is the one part of `runs/process.py` that cannot be exercised here, so
    it is checked by construction instead. ctypes defaults `restype` to `c_int`,
    and every one of these functions returns or accepts a `HANDLE` — pointer-
    sized, so 64 bits on any Windows this runs on. An undeclared handle is
    truncated to its low 32 bits and is *still non-zero*, so every `if not
    handle` guard passes and each later call is made against something invalid.

    The failure that produces is silent and wrong in the worst direction:
    `TerminateJobObject` fails, cancellation falls through to `taskkill /T`,
    which walks parent-pid links and so cannot reach the orphaned solver that
    the job object exists to kill. A run would report itself cancelled while the
    solver kept a core busy.

    These tests run on every platform, which is the point — they are what stops
    an undeclared call reaching a user's Windows machine unreviewed.
    """

    def _call_sites(self) -> set[str]:
        """Every `k32.<Name>(` in the package, which is where the calls live."""
        import re
        from pathlib import Path

        source_dir = Path(process.__file__).parent
        found: set[str] = set()
        for name in ("process.py", "worker.py"):
            text = (source_dir / name).read_text()
            found |= set(re.findall(r"\bk32\.([A-Za-z]\w+)\(", text))
        return found

    def test_every_call_site_has_a_signature(self):
        """A call added without one is truncation waiting to happen."""
        declared = set(process._KERNEL32_SIGNATURES())

        missing = self._call_sites() - declared

        assert missing == set(), (
            f"kernel32 calls with no declared signature: {sorted(missing)}"
        )

    def test_no_signature_is_declared_for_a_call_that_is_gone(self):
        """The table is a description of this code, not a wish list."""
        declared = set(process._KERNEL32_SIGNATURES())

        assert declared - self._call_sites() == set()

    def test_every_return_type_is_one_of_the_windows_types(self):
        """Nothing is left to ctypes' default, which truncates a handle.

        Stated positively, and that is not a stylistic choice. The obvious
        phrasing — `assert restype is not ctypes.c_int` — passes here and can
        never pass on Windows, because there `ctypes.c_int` **is**
        `ctypes.c_long` (both 32-bit, and CPython returns the same object) while
        `wintypes.BOOL` is `c_long`. The assertion reduced to
        `c_long is not c_long`. It was the test that was unportable, not the
        bindings; CI on Windows is what said so.

        Naming the permitted types instead says the same thing and means it on
        both platforms: a default `restype` is `c_int`, which is not among them
        on any platform where the distinction matters.
        """
        from ctypes import wintypes

        permitted = {wintypes.HANDLE, wintypes.BOOL, wintypes.DWORD}
        for name, (_argtypes, restype) in process._KERNEL32_SIGNATURES().items():
            assert restype in permitted, (
                f"{name} returns {restype}, which is not a declared Windows type"
            )

    def test_the_handle_returning_calls_say_so(self):
        """The four whose truncation is the actual bug, named individually.

        A blanket check over the table would still pass if one of these were
        quietly declared `BOOL`, which is 32 bits and would truncate exactly as
        the default did.
        """
        from ctypes import wintypes

        signatures = process._KERNEL32_SIGNATURES()
        for name in (
            "CreateJobObjectW",
            "OpenJobObjectW",
            "OpenProcess",
            "GetCurrentProcess",
            "GetStdHandle",
        ):
            assert signatures[name][1] is wintypes.HANDLE, f"{name} must return HANDLE"

    def test_the_worker_shares_the_declared_library(self):
        """Two `WinDLL` objects would mean one of them undeclared.

        `worker.py` built its own before this, so its `SetHandleInformation`
        call — the one handed a real 64-bit handle by `msvcrt.get_osfhandle` —
        would have raised `ArgumentError` into an `except Exception` and left
        the solver's output uncaptured, silently.
        """
        from pathlib import Path

        worker_source = (Path(process.__file__).parent / "worker.py").read_text()

        # The *call*, not the word — the comment there names `WinDLL` precisely
        # to say why building one would be wrong.
        assert "ctypes.WinDLL(" not in worker_source
        assert "process._kernel32()" in worker_source
