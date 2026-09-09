"""A commit's tree on disk, so it can be read like a folder.

A compare side is a directory: `files_diff` digests files off it, `file_pair`
reads them, and the resolver is handed it as a synthetic workspace to ask
Calliope what the model means. So a commit has to be *materialised* rather
than read blob by blob. `git archive` writes a tar of the folder at that
commit — rooted at the folder when it is nested inside a larger repository —
and `tarfile` extracts it, so there is no shell pipe and it works on Windows.

A commit is immutable, so the tree is a cache keyed by sha alone: built once
and then simply found, which is also what lets the resolver's entry for it be
built once and then simply hit.
"""

from __future__ import annotations

import io
import os
import shutil
import tarfile
import tempfile
from pathlib import Path

from calliope_studio.vcs.command import run
from calliope_studio.vcs.repo import Repo

#: Written last, so a tree that is here is a tree that is whole. Dot-prefixed,
#: which keeps it out of every listing the tree is then read with.
MARKER = ".materialised"


def materialise(repo: Repo, sha: str, dest: Path) -> Path:
    """Puts the folder as it was at `sha` under `dest`, once.

    Extracted into a sibling scratch directory and renamed into place, so a
    reader never sees a half-written tree. Two requests racing for the same
    commit both extract and one rename loses, which is fine: theirs is
    identical, and the loser throws its copy away.

    Raises:
        GitError: If the commit does not exist, or the folder did not at that
            commit.
    """
    if (dest / MARKER).is_file():
        return dest
    tree = sha if repo.pathspec == "." else f"{sha}:{repo.pathspec}"
    completed = run(["archive", "--format=tar", tree], repo.root)

    dest.parent.mkdir(parents=True, exist_ok=True)
    scratch = Path(tempfile.mkdtemp(prefix=f"{dest.name}.", dir=dest.parent))
    try:
        with tarfile.open(fileobj=io.BytesIO(completed.stdout), mode="r:") as archive:
            # `data` refuses absolute paths and links pointing out of the tree,
            # which a tar written by git never contains and a reader of one
            # should never trust it not to.
            archive.extractall(scratch, filter="data")
        (scratch / MARKER).write_text(sha, encoding="utf-8")
        try:
            os.rename(scratch, dest)
        except OSError:
            shutil.rmtree(scratch, ignore_errors=True)
            if not (dest / MARKER).is_file():
                raise
    except BaseException:
        shutil.rmtree(scratch, ignore_errors=True)
        raise
    return dest
