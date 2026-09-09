"""The one place git is run.

Every call in this package is `subprocess.run` against the system `git`, and
they all come through here: one timeout, one decoding rule, one error type.

`--no-optional-locks` on every invocation. Studio asks for `status` after every
save, and without the flag each of those refreshes the index and takes the lock
that a `git commit` running in the user's terminal then fails to get.
"""

from __future__ import annotations

import functools
import os
import shutil
import subprocess
from pathlib import Path

#: How long any one git command may take. A status is milliseconds; the ceiling
#: is for a wedged hook or a network filesystem, so that a stuck git costs a
#: request rather than the server.
GIT_TIMEOUT_SECONDS = 60.0


class GitError(RuntimeError):
    """A git command that exited non-zero, carrying what git said.

    The stderr is the message: git's own complaint — "index.lock exists",
    "pathspec did not match" — is what somebody debugging the failure needs,
    and every wrapper here passes it through rather than paraphrasing it.
    """

    def __init__(self, command: list[str], returncode: int, stderr: str) -> None:
        self.command = command
        self.returncode = returncode
        self.stderr = stderr.strip()
        super().__init__(
            self.stderr or f"git {' '.join(command)} failed ({returncode})"
        )


@functools.cache
def git_executable() -> str | None:
    """Where `git` is, looked up once per process."""
    return shutil.which("git")


def git_available() -> bool:
    """Whether there is a git to run at all.

    Load-bearing rather than belt-and-braces: nothing about installing this
    package requires git — `setuptools_scm` has a `fallback_version` precisely
    so a build without it works — and the whole feature has to be absent rather
    than broken on a machine without the binary.
    """
    return git_executable() is not None


def _environment() -> dict[str, str]:
    env = dict(os.environ)
    # Never a prompt: nothing here has a terminal to answer on, and a git
    # waiting for a passphrase is a request that never returns.
    env["GIT_TERMINAL_PROMPT"] = "0"
    # English messages, which is what the identity and signing matches read.
    env["LC_ALL"] = "C"
    return env


def run(
    args: list[str], cwd: Path, *, check: bool = True
) -> subprocess.CompletedProcess[bytes]:
    """Runs git, returning raw bytes.

    Bytes, because two callers want them: a blob out of `git show` may be a
    CSV in any encoding or not text at all, and only the caller can decide
    what to do with a NUL in the first few kilobytes.
    """
    executable = git_executable()
    if executable is None:
        raise GitError(args, 127, "git is not installed")
    completed = subprocess.run(
        [executable, "--no-optional-locks", *args],
        cwd=cwd,
        capture_output=True,
        timeout=GIT_TIMEOUT_SECONDS,
        env=_environment(),
    )
    if check and completed.returncode != 0:
        # stdout as the fallback, because `commit -q` with nothing to commit
        # says so there and leaves stderr empty.
        said = _text(completed.stderr).strip() or _text(completed.stdout)
        raise GitError(args, completed.returncode, said)
    return completed


def git(args: list[str], cwd: Path, *, check: bool = True) -> str:
    """Runs git and returns its stdout as text.

    `errors="replace"`, matching what every other reader of a model file does:
    a path with a stray Latin-1 byte in it is still a path worth listing.
    """
    return _text(run(args, cwd, check=check).stdout)


def _text(data: bytes) -> str:
    return data.decode("utf-8", errors="replace")
