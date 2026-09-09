"""Putting a model folder under version control, when asked.

Only when asked. A folder is never initialised as a side effect of opening it:
a `.git` directory is metadata in somebody's folder, and a user who keeps
their models some other way did not ask for one. The route offers it and the
dialog shows what will be written before anything is.
"""

from __future__ import annotations

from pathlib import Path

from calliope_studio.vcs.command import run
from calliope_studio.vcs.commit import IdentityMissing, has_identity
from calliope_studio.vcs.repo import Repo, discover

#: What a fresh repository ignores. Run outputs are not here because
#: `calliope-studio/` already writes a `.gitignore` of its own covering itself;
#: `*.nc` is the one Calliope-specific line, since a solved model is a large
#: derived binary that a run recreates.
DEFAULT_GITIGNORE = """\
# Solved models: large derived binaries that a run recreates.
*.nc
.DS_Store
__pycache__/
.ipynb_checkpoints/
"""

INITIAL_MESSAGE = "Initial commit"


class AlreadyTracked(RuntimeError):
    """The folder is the top level of a repository already."""


def init(workspace: Path, *, gitignore: bool = True) -> Repo:
    """Creates a repository at the folder and makes its first commit.

    A folder *inside* another repository may still be initialised — that is
    the offer made for a folder the parent ignores — and the new repository
    then owns it. The identity is checked before anything is written, so a
    machine with no `user.email` is told so with the folder untouched rather
    than left with a repository holding nothing.

    The first commit is made with signing off. That commit is the one an
    inherited `commit.gpgsign=true` with a broken helper stops from ever
    happening, and a repository with no first commit has no branch, no HEAD
    and nothing for any later question to be asked against.
    """
    workspace = Path(workspace).resolve()
    existing = discover(workspace)
    if existing is not None and not existing.nested:
        raise AlreadyTracked(f"{workspace} is already a git repository.")
    if not has_identity(workspace):
        raise IdentityMissing(
            ["init"],
            1,
            "git does not know who you are. Set user.name and user.email with "
            "`git config --global`, then try again.",
        )

    # `-b` needs git 2.28; older ones get the same branch name the long way.
    if run(["init", "-q", "-b", "main"], workspace, check=False).returncode != 0:
        run(["init", "-q"], workspace)
        run(["symbolic-ref", "HEAD", "refs/heads/main"], workspace)

    target = workspace / ".gitignore"
    if gitignore and not target.exists():
        with target.open("w", encoding="utf-8", newline="") as handle:
            handle.write(DEFAULT_GITIGNORE)

    run(["add", "-A", "--", "."], workspace)
    run(
        ["-c", "commit.gpgsign=false", "commit", "-q", "-m", INITIAL_MESSAGE], workspace
    )

    repo = discover(workspace)
    if repo is None:
        raise RuntimeError(f"git init succeeded but {workspace} is not a repository.")
    return repo
