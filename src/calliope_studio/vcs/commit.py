"""Recording the folder's changes as a commit.

Two failures get their own type because the route has to say something a
user can act on. A missing identity is the commonest first-run failure and
git's own message is a paragraph about `git config --global`; a signing
failure is retried once unsigned, because an inherited `commit.gpgsign=true`
with a broken helper is what stops a first commit ever happening, and only a
signing failure is retried so nothing else is masked.
"""

from __future__ import annotations

from pathlib import Path

from calliope_studio.vcs.command import GitError, git, run
from calliope_studio.vcs.repo import Repo


class IdentityMissing(GitError):
    """`user.name` or `user.email` is unset, so nothing can be committed."""


class NothingToCommit(GitError):
    """The paths asked for hold no change to record."""


#: What git says when the signing helper, rather than the commit, is broken.
SIGNING_FAILURES = (
    "gpg failed",
    "failed to sign",
    "signing failed",
    "gpg.ssh",
    "no secret key",
    "secret key not available",
)

#: What git says when a commit would record nothing.
EMPTY_COMMIT = (
    "nothing to commit",
    "nothing added to commit",
    "no changes added to commit",
    "did not match any file",
)


def has_identity(cwd: Path) -> bool:
    """Whether git knows who would be committing here."""
    for key in ("user.name", "user.email"):
        completed = run(["config", "--get", key], cwd, check=False)
        if completed.returncode != 0 or not completed.stdout.strip():
            return False
    return True


def commit(repo: Repo, paths: list[str] | None, message: str) -> str:
    """Commits the given workspace-relative paths, or everything under the
    folder, and returns the new commit's sha.

    `add -A` on the pathspecs first, so untracked files are included and a
    deletion is recorded; then `commit -- <pathspecs>`, which records the
    current content of exactly those paths and ignores anything else the
    user's terminal may have staged in the meantime.
    """
    message = message.strip()
    if not message:
        raise ValueError("A commit needs a message.")
    if not has_identity(repo.root):
        raise IdentityMissing(
            ["commit"],
            1,
            "git does not know who you are. Set user.name and user.email with "
            "`git config --global`, then commit again.",
        )
    specs = [repo.relative(path) for path in paths] if paths else [repo.pathspec]
    run(["add", "-A", "--", *specs], repo.root)
    try:
        _commit(repo, message, specs)
    except GitError as failure:
        lowered = failure.stderr.lower()
        if any(marker in lowered for marker in SIGNING_FAILURES):
            _commit(repo, message, specs, sign=False)
        elif any(marker in lowered for marker in EMPTY_COMMIT):
            raise NothingToCommit(
                failure.command, failure.returncode, "There is nothing to commit."
            ) from None
        else:
            raise
    return git(["rev-parse", "HEAD"], repo.root).strip()


def _commit(repo: Repo, message: str, specs: list[str], *, sign: bool = True) -> None:
    args = ["commit", "-q", "-m", message, "--", *specs]
    if not sign:
        args = ["-c", "commit.gpgsign=false", *args]
    run(args, repo.root)
