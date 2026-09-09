"""What differs from the last commit, file by file.

Parsed from `status --porcelain=v1 -z`, whose paths are always relative to the
repository root whatever the working directory, and whose `-z` form puts a
rename's *new* path first. Every path is converted to workspace-relative on
the way out, so the list keys straight into the file tree.
"""

from __future__ import annotations

from dataclasses import dataclass

from calliope_studio.vcs.command import run
from calliope_studio.vcs.repo import Repo

#: The two-letter codes git uses for an unmerged path. A file left this way by
#: the user's own `git pull` is shown as what it is rather than mislabelled as
#: modified; resolving it is their git client's job.
CONFLICT_CODES = frozenset({"DD", "AU", "UD", "UA", "DU", "AA", "UU"})

STATES = ("added", "modified", "deleted", "untracked", "renamed", "conflicted")


@dataclass(frozen=True)
class FileStatus:
    """One file that differs from HEAD."""

    #: Workspace-relative.
    path: str
    #: git's own two columns, for anything that wants the detail.
    index: str
    worktree: str
    #: One of `STATES`.
    state: str
    #: Where a renamed file came from, workspace-relative.
    original: str | None = None

    def as_dict(self) -> dict:
        return {
            "path": self.path,
            "index": self.index,
            "worktree": self.worktree,
            "state": self.state,
            "original": self.original,
        }


def changes(repo: Repo) -> list[FileStatus]:
    """Every file under the folder that differs from HEAD, untracked included.

    Empty, not an error, for a folder the repository ignores: git reports
    nothing about it, and the caller already knows why from `repo.ignored`.
    """
    completed = run(
        [
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--",
            repo.pathspec,
        ],
        repo.root,
    )
    return parse_porcelain(completed.stdout.decode("utf-8", errors="replace"), repo)


def parse_porcelain(text: str, repo: Repo) -> list[FileStatus]:
    """Reads `--porcelain=v1 -z` output.

    Separate from `changes` so the parser can be tested on fixed text: git's
    rename form is the one thing here worth pinning, since it is documented
    as "reversed" from the human format and reads plausibly either way.
    """
    tokens = text.split("\0")
    found: list[FileStatus] = []
    position = 0
    while position < len(tokens):
        token = tokens[position]
        position += 1
        if len(token) < 4:
            continue
        code, root_path = token[:2], token[3:]
        original: str | None = None
        if code[0] in "RC":
            original = (
                repo.unrelative(tokens[position]) if position < len(tokens) else None
            )
            position += 1
        path = repo.unrelative(root_path)
        if path is None:
            continue
        found.append(
            FileStatus(
                path=path,
                index=code[0],
                worktree=code[1],
                state=state_of(code),
                original=original,
            )
        )
    return sorted(found, key=lambda entry: entry.path)


def state_of(code: str) -> str:
    """The one-word state for git's two-letter code."""
    if code == "??":
        return "untracked"
    if code in CONFLICT_CODES:
        return "conflicted"
    if code[0] in "RC":
        return "renamed"
    if "A" in code:
        return "added"
    if "D" in code:
        return "deleted"
    return "modified"
