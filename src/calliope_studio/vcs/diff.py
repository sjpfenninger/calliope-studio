"""Two versions of one file, as two whole texts.

Not a patch. The frontend renders with Monaco's diff editor, which takes both
sides and computes the difference itself — the same pane the compare view
already uses — so a unified diff would be parsed only to be thrown away.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from calliope_studio.vcs.command import run
from calliope_studio.vcs.repo import Repo

#: The largest side that will be handed to the browser whole. The same
#: ceiling the editor's own reads apply, for the same reason: a hundred
#: megabyte CSV becomes a JSON string, is escaped into a larger one, and is
#: then given to Monaco.
MAX_DIFF_BYTES = 8 * 1024 * 1024

#: How far in to look for a NUL before calling a file binary — git's own test,
#: and `server.deps.decode_text`'s.
NUL_SNIFF_BYTES = 8000


@dataclass(frozen=True)
class Diff:
    path: str
    #: Empty when the file did not exist on that side, or when it cannot be
    #: shown as text; `binary` and `truncated` say which.
    original: str
    modified: str
    binary: bool
    truncated: bool
    #: Whether each side had the file at all: an addition has no original, a
    #: deletion no modified, and an empty string alone cannot say which.
    original_exists: bool
    modified_exists: bool

    def as_dict(self) -> dict:
        return {
            "path": self.path,
            "original": self.original,
            "modified": self.modified,
            "binary": self.binary,
            "truncated": self.truncated,
            "original_exists": self.original_exists,
            "modified_exists": self.modified_exists,
        }


def working_diff(repo: Repo, path: str) -> Diff:
    """The file as HEAD has it against the file as it is on disk."""
    return _diff(path, _blob(repo, "HEAD", path), _disk(repo, path))


def commit_diff(repo: Repo, sha: str, path: str) -> Diff:
    """The file before and after one commit."""
    return _diff(path, _blob(repo, f"{sha}^", path), _blob(repo, sha, path))


def _blob(repo: Repo, revision: str, path: str) -> bytes | None:
    """A file's bytes at a revision, or None if it was not there.

    `check=False` on purpose: the file being absent from that revision is the
    normal way an addition or a deletion reads, and the root commit has no
    parent for `sha^` to name.
    """
    completed = run(
        ["show", f"{revision}:{repo.relative(path)}"], repo.root, check=False
    )
    return completed.stdout if completed.returncode == 0 else None


def _disk(repo: Repo, path: str) -> bytes | None:
    try:
        return (repo.workspace / Path(path)).read_bytes()
    except OSError:
        return None


def _diff(path: str, before: bytes | None, after: bytes | None) -> Diff:
    sides = [side for side in (before, after) if side is not None]
    binary = any(b"\0" in side[:NUL_SNIFF_BYTES] for side in sides)
    truncated = any(len(side) > MAX_DIFF_BYTES for side in sides)

    def text(side: bytes | None) -> str:
        if side is None or binary or truncated:
            return ""
        return side.decode("utf-8", errors="replace")

    return Diff(
        path=path,
        original=text(before),
        modified=text(after),
        binary=binary,
        truncated=truncated,
        original_exists=before is not None,
        modified_exists=after is not None,
    )
