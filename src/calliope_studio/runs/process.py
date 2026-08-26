"""Spawning a run's worker, and killing it and everything it started.

The one place that knows how a process group works on this platform. It exists
as a module rather than as branches inside `manager.py` because three scattered
`sys.platform` tests is how the two halves drift, and because `worker.py` needs
`join_group` too — and `worker → manager` would invert the layering, where both
are today siblings importing only `protocol`.

**The requirement is not "stop the worker".** Calliope offers no interrupt API —
no timeout, no solver callback, no `KeyboardInterrupt` handling — so cancelling
means killing, and what has to die is the solver the worker started, which is a
*grandchild* of the server. The manager also has to be able to kill a process it
did not spawn, because a run outlives the server that started it and a restarted
server finds it by a pid on disk.

POSIX does this with a session: `start_new_session=True`, then a signal to the
process group. Windows has no such thing, and the tempting analogue —
`CREATE_NEW_PROCESS_GROUP` plus `CTRL_BREAK_EVENT` — is not sufficient: a control
event only reaches processes sharing the *caller's* console, which a restarted
server does not have and a detached one may not have at all; it is
advisory, with no forcible counterpart; and it arrives in Python as
`KeyboardInterrupt`, which Calliope does not handle. So Windows uses a **Job
Object**, where membership is inherited by children automatically, is a kernel
property rather than a parent-pid chain, and `TerminateJobObject` is the
unconditional group kill that a signal to a process group provides.

Two things about the Windows side are load-bearing and easy to get wrong:

- **The worker creates and joins its own job, and holds the handle for its whole
  life.** A named kernel object is unlinked from the namespace when its *handle*
  count reaches zero, even while assigned processes keep it alive — so a job
  created by the server becomes anonymous the moment the server exits, and
  `OpenJobObjectW` by name then fails in exactly the post-restart case that has
  to work. Self-assignment as the first act of `worker.main()`, before
  `import calliope`, also closes the window in which a solver could be spawned
  outside the job and so escape the kill.
- **`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` is deliberately not set.** It would kill
  every running solve when the server exits, which is the exact inverse of the
  invariant the run protocol is built on — a run outlives its server. `pixi run
  serve` uses `--reload`, so it would fire on every code edit.
"""

import os
import signal
import subprocess
from pathlib import Path
from typing import IO

IS_WINDOWS = os.name == "nt"

#: How long a worker is given to exit after being asked nicely, before it is
#: killed outright. Only POSIX asks nicely; see `terminate_group`.
GRACE_SECONDS = 5.0


# ---------------------------------------------------------------------------
# Spawning
# ---------------------------------------------------------------------------


def spawn(
    argv: list[str],
    *,
    log_file: IO[bytes] | IO[str],
    env: dict[str, str] | None = None,
    cwd: Path | None = None,
) -> subprocess.Popen:
    """Starts a worker in its own killable group.

    Args:
        argv: The command, `[interpreter, "-m", module, run_dir]`.
        log_file: Where stdout and stderr go. The caller closes it as soon as
            the child has inherited it; holding one open per run leaks a
            descriptor for the lifetime of the server.
        env: The child's whole environment, or None to inherit this one's. A
            parameter from the outset because pointing a run at another Calliope
            means handing its interpreter a different `PYTHONPATH` and `PATH`,
            and retrofitting it later would mean rewriting the platform split.
        cwd: Working directory for the child, or None for this process's.

    Returns:
        The started process.

    Raises:
        OSError: If the child could not be started. Callers turn this into
            `WorkerStartError`; it is not caught here, because this module has
            nothing better to say about it than the operating system does.
    """
    kwargs: dict = {
        "stdout": log_file,
        "stderr": subprocess.STDOUT,
        "env": env,
        "cwd": None if cwd is None else str(cwd),
    }
    if IS_WINDOWS:
        # The `start_new_session` analogue: detach from the launching terminal,
        # so a console closing does not take a running solve with it. The job
        # that makes the group killable is created by the worker itself.
        kwargs["creationflags"] = (
            subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
        )
    else:
        kwargs["start_new_session"] = True
    return subprocess.Popen(argv, **kwargs)


def join_group(name: str) -> object | None:
    """Puts this process into the killable group `name`, returning its handle.

    Called by the worker as its first act. A no-op on POSIX, where
    `start_new_session` in the parent has already done it and the session cannot
    be joined afterwards anyway.

    The returned handle must be **kept referenced for the process's whole life**:
    on Windows the job is unlinked from the namespace when the last handle closes,
    and the manager finds it by name. Returns None when there is nothing to hold.
    """
    if not IS_WINDOWS:
        return None
    return _windows_join_job(name)


# ---------------------------------------------------------------------------
# Liveness and killing
# ---------------------------------------------------------------------------


def is_running(pid: int, group: str | None = None) -> bool:
    """Whether a worker is still alive.

    Args:
        pid: The recorded process id.
        group: The group name, on platforms that have one by name. Windows can
            answer from the job's existence, which is immune to the pid reuse
            the POSIX side has to live with.
    """
    if IS_WINDOWS:
        if group is not None and _windows_job_exists(group):
            return True
        return _windows_pid_alive(pid)
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def signal_group(pid: int, sig: int) -> bool:
    """Sends `sig` to the group led by `pid`. POSIX only; False if it is gone."""
    try:
        os.killpg(os.getpgid(pid), sig)
    except OSError:
        return False
    return True


def terminate_group(pid: int, group: str | None = None) -> bool:
    """Kills a worker and everything it started, without waiting.

    The graceful tier is POSIX-only: there is no forcible-with-a-warning on
    Windows, and a control event is not a substitute (see the module docstring).
    Nothing downstream depends on the difference — `manager.cancel` writes the
    cancellation marker *before* killing, so the run is recorded as cancelled
    either way, and the worker's own cancellation poll gives it a chance to flush
    on both platforms.

    Returns:
        Whether anything was signalled. False means it had already gone.
    """
    if IS_WINDOWS:
        return _windows_terminate(pid, group)
    return signal_group(pid, signal.SIGTERM)


def kill_group(pid: int, group: str | None = None) -> bool:
    """The unconditional tier, after `terminate_group` has been given its grace."""
    if IS_WINDOWS:
        return _windows_terminate(pid, group)
    return signal_group(pid, signal.SIGKILL)


# ---------------------------------------------------------------------------
# Windows
# ---------------------------------------------------------------------------
#
# ctypes rather than pywin32: this is four calls, and the alternative is a
# dependency that ships no wheel for some Python versions and is needed by
# nothing else here.

_JOB_ALL_ACCESS = 0x1F001F
_PROCESS_TERMINATE = 0x0001
_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
_SYNCHRONIZE = 0x00100000
_WAIT_TIMEOUT = 0x00000102


def _kernel32():
    import ctypes

    return ctypes.WinDLL("kernel32", use_last_error=True)


def _windows_join_job(name: str) -> object | None:
    """Creates or opens the named job and assigns this process to it."""
    import ctypes

    k32 = _kernel32()
    # Create rather than open: the worker is the first and only thing that needs
    # it to exist, and creating an existing name simply opens it.
    handle = k32.CreateJobObjectW(None, name)
    if not handle:
        return None
    current = k32.GetCurrentProcess()
    if not k32.AssignProcessToJobObject(handle, current):
        # Already in a job that forbids nesting — an outer container, or a
        # debugger. The run still works; only the group kill degrades to
        # terminating the worker alone, which `_windows_terminate` falls back to.
        k32.CloseHandle(handle)
        return None
    # Returned so the caller can hold it: closing it here would unlink the name
    # and make the job unfindable, which is the whole failure this design exists
    # to avoid.
    return ctypes.c_void_p(handle)


def _windows_job_exists(name: str) -> bool:
    k32 = _kernel32()
    handle = k32.OpenJobObjectW(_JOB_ALL_ACCESS, False, name)
    if not handle:
        return False
    k32.CloseHandle(handle)
    return True


def _windows_pid_alive(pid: int) -> bool:
    """Whether `pid` names a live process.

    `WaitForSingleObject` with a zero timeout rather than `GetExitCodeProcess`
    against `STILL_ACTIVE`: 259 is a legitimate exit code, so a process that
    genuinely returned it would read as running for ever.
    """
    k32 = _kernel32()
    handle = k32.OpenProcess(
        _SYNCHRONIZE | _PROCESS_QUERY_LIMITED_INFORMATION, False, pid
    )
    if not handle:
        return False
    try:
        return k32.WaitForSingleObject(handle, 0) == _WAIT_TIMEOUT
    finally:
        k32.CloseHandle(handle)


def _windows_terminate(pid: int, group: str | None) -> bool:
    """Job, then process, then `taskkill` — each strictly weaker than the last."""
    k32 = _kernel32()

    if group is not None:
        handle = k32.OpenJobObjectW(_JOB_ALL_ACCESS, False, group)
        if handle:
            try:
                if k32.TerminateJobObject(handle, 1):
                    return True
            finally:
                k32.CloseHandle(handle)

    handle = k32.OpenProcess(_PROCESS_TERMINATE, False, pid)
    if handle:
        try:
            if k32.TerminateProcess(handle, 1):
                return True
        finally:
            k32.CloseHandle(handle)

    # Last resort, and honestly incomplete: `/T` walks parent-pid links, which a
    # solver that has outlived an intermediate process is no longer on.
    try:
        return (
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(pid)],
                capture_output=True,
                creationflags=subprocess.CREATE_NO_WINDOW,
            ).returncode
            == 0
        )
    except OSError:
        return False
