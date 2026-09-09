"""Which repository a model folder is in, and where in it.

The answer is not a boolean. A model folder is very often *inside* a larger
repository — a paper's, a project's — and two things follow. Every question
has to be scoped to the folder by a pathspec, or the Changes list shows the
whole thesis; and the folder may be ignored by that repository, in which case
naive "is this a repo?" says yes and then every list is permanently empty
with nothing to explain why. That last state is not hypothetical: it is what
`pixi run serve` opens, since `example-model/` is gitignored inside this very
repository.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from calliope_studio.vcs.command import git, git_available, run

#: A sha, abbreviated or not. Anything else is a probe: the value is about to
#: be spliced into a revision argument such as `<sha>:<path>`.
SHA_RE = re.compile(r"\A[0-9a-fA-F]{4,40}\Z")


@dataclass(frozen=True)
class Repo:
    """A model folder's place in a git repository."""

    #: The repository's top level.
    root: Path
    #: The model folder, resolved.
    workspace: Path
    #: The folder relative to the root, as a pathspec: `"."` when they coincide.
    #: Every git command this package runs is scoped by it, which is what keeps
    #: a nested model from showing its parent repository's files.
    pathspec: str
    #: The current branch, or None when detached with nothing to name.
    branch: str | None
    detached: bool
    #: Whether the folder is somewhere below the root rather than at it.
    nested: bool
    #: Whether the repository ignores the folder. Only a nested folder can be.
    ignored: bool

    @property
    def tracked(self) -> bool:
        """Whether git will say anything about this folder's files."""
        return not self.ignored

    def relative(self, path: str) -> str:
        """A workspace-relative path as git names it, from the root."""
        return path if self.pathspec == "." else f"{self.pathspec}/{path}"

    def unrelative(self, root_relative: str) -> str | None:
        """The workspace-relative form of a root-relative path, or None if
        the path lies outside the folder."""
        if self.pathspec == ".":
            return root_relative
        prefix = f"{self.pathspec}/"
        if root_relative.startswith(prefix):
            return root_relative[len(prefix) :]
        return None

    def as_dict(self) -> dict:
        return {
            "root": str(self.root),
            "branch": self.branch,
            "detached": self.detached,
            "nested": self.nested,
            "ignored": self.ignored,
        }


def discover(workspace: Path) -> Repo | None:
    """The repository a folder is in, or None if it is in none.

    `rev-parse --show-toplevel` handles a linked worktree (a `.git` *file*)
    and a submodule (which resolves to the submodule, the right answer) on its
    own. Both resolved before the pathspec is computed: the workspace path is
    already `Path.resolve()`d by `workspace_id`, and git prints the real path,
    so a symlinked model folder comes out consistent.
    """
    workspace = Path(workspace).resolve()
    if not git_available() or not workspace.is_dir():
        return None
    completed = run(["rev-parse", "--show-toplevel"], workspace, check=False)
    if completed.returncode != 0:
        return None
    root = Path(completed.stdout.decode("utf-8", errors="replace").strip()).resolve()
    try:
        relative = workspace.relative_to(root)
    except ValueError:
        return None
    pathspec = relative.as_posix() if relative.parts else "."
    nested = pathspec != "."
    branch, detached = _branch(root)
    ignored = (
        nested
        and run(["check-ignore", "-q", "--", pathspec], root, check=False).returncode
        == 0
    )
    return Repo(
        root=root,
        workspace=workspace,
        pathspec=pathspec,
        branch=branch,
        detached=detached,
        nested=nested,
        ignored=ignored,
    )


def _branch(root: Path) -> tuple[str | None, bool]:
    """The branch name, or the short sha when detached."""
    named = run(["symbolic-ref", "--short", "-q", "HEAD"], root, check=False)
    if named.returncode == 0:
        return named.stdout.decode("utf-8", errors="replace").strip(), False
    short = run(["rev-parse", "--short", "HEAD"], root, check=False)
    if short.returncode == 0:
        return short.stdout.decode("utf-8", errors="replace").strip(), True
    return None, True


def head(repo: Repo) -> str | None:
    """The commit HEAD names, or None on a branch with no commits yet."""
    completed = run(["rev-parse", "--verify", "-q", "HEAD"], repo.root, check=False)
    if completed.returncode != 0:
        return None
    return git(["rev-parse", "HEAD"], repo.root).strip()
