"""Throwing a file's uncommitted changes away.

The one destructive operation in the package, and deliberately the only one:
it puts a single file back to how HEAD has it, and nothing here moves the
working tree as a whole.
"""

from __future__ import annotations

from pathlib import Path

from calliope_studio.vcs.command import run
from calliope_studio.vcs.repo import Repo


def discard(repo: Repo, path: str) -> None:
    """Returns one workspace-relative path to its committed state.

    A file HEAD has is checked out from it, index and working tree both. A
    file HEAD does not have — untracked, or added and staged — is unstaged
    and removed, which is what "discard" means for something that was never
    committed.
    """
    spec = repo.relative(path)
    in_head = (
        run(["cat-file", "-e", f"HEAD:{spec}"], repo.root, check=False).returncode == 0
    )
    if in_head:
        run(["checkout", "-q", "HEAD", "--", spec], repo.root)
        return
    run(["rm", "-q", "--cached", "--ignore-unmatch", "--", spec], repo.root)
    target = repo.workspace / Path(path)
    if target.is_file():
        target.unlink()
