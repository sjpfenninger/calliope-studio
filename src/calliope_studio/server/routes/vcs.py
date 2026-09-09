"""Version tracking: what changed, committing it, and reading history.

The one HTTP surface over the `vcs` layer. Every path arrives untrusted and is
resolved here — `deps.resolve_path` for a read, `deps.resolve_writable_path`
for anything that touches the tree — before it reaches `vcs`, which never
resolves one itself. Every sha is checked against `SHA_RE` for the same
reason: it is spliced into a git revision argument.

`GET …/vcs/` is the one cheap poll and reports a *state* rather than a
boolean, because "is this a repo?" has four answers here and two of them look
identical from a list that is empty: no git on the machine, a folder in no
repository, a folder inside a repository that ignores it, and a folder git
will actually say something about.
"""

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from calliope_studio.server.deps import (
    get_workspace,
    resolve_path,
    resolve_writable_path,
)
from calliope_studio.server.storage import Workspace
from calliope_studio.vcs import commit as vcs_commit
from calliope_studio.vcs import diff as vcs_diff
from calliope_studio.vcs import discard as vcs_discard
from calliope_studio.vcs import init as vcs_init
from calliope_studio.vcs import log as vcs_log
from calliope_studio.vcs import repo as vcs_repo
from calliope_studio.vcs import status as vcs_status
from calliope_studio.vcs.command import GitError, git_available
from calliope_studio.vcs.repo import SHA_RE

router = APIRouter(tags=["vcs"])

STATE_NO_GIT = "no_git"
STATE_UNTRACKED = "untracked"
STATE_IGNORED = "ignored"
STATE_READY = "ready"

#: What is said for each state that cannot be asked about, when something is.
NOT_READY = {
    STATE_NO_GIT: "git is not installed on this machine.",
    STATE_UNTRACKED: "This model is not tracked with git.",
    STATE_IGNORED: (
        "This folder is inside a repository that ignores it, so git records "
        "nothing about it."
    ),
}


class CommitBody(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    #: Workspace-relative. Omitted, everything under the folder is committed.
    paths: list[str] | None = None


class DiscardBody(BaseModel):
    path: str


def _state(repo: vcs_repo.Repo | None) -> str:
    if not git_available():
        return STATE_NO_GIT
    if repo is None:
        return STATE_UNTRACKED
    if repo.ignored:
        return STATE_IGNORED
    return STATE_READY


def _discover(workspace: Workspace) -> vcs_repo.Repo | None:
    return vcs_repo.discover(workspace.path) if git_available() else None


def _ready(workspace: Workspace) -> vcs_repo.Repo:
    """The repository, or a 409 saying which of the three reasons there is none."""
    repo = _discover(workspace)
    state = _state(repo)
    if repo is None or state != STATE_READY:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail=NOT_READY[state]
        )
    return repo


def _sha(sha: str) -> str:
    if not SHA_RE.match(sha):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Not a commit id."
        )
    return sha


def _relative(workspace: Workspace, path: str, *, writable: bool = False) -> str:
    """A request path as the workspace-relative posix form git is given.

    Resolved and re-relativised rather than passed through, so `./a//b` and
    `a/b` are one path and a traversal is refused before git sees it.
    """
    resolved = (
        resolve_writable_path(workspace, path)
        if writable
        else resolve_path(workspace, path)
    )
    relative = resolved.relative_to(workspace.path.resolve()).as_posix()
    if relative in ("", "."):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="A file path is needed."
        )
    return relative


def _failure(problem: GitError) -> HTTPException:
    """git's own complaint, at the status that says what kind it is.

    A held `index.lock` from the user's terminal is a 409 like any other
    refusal; a missing identity and an empty commit are the request's problem.
    """
    if isinstance(problem, (vcs_commit.IdentityMissing, vcs_commit.NothingToCommit)):
        return HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(problem)
        )
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(problem))


def _status_payload(workspace: Workspace) -> dict:
    repo = _discover(workspace)
    state = _state(repo)
    payload: dict = {
        "available": git_available(),
        "tracked": state == STATE_READY,
        "state": state,
        "root": None,
        "branch": None,
        "detached": False,
        "nested": False,
        "changed": 0,
        "head": None,
        # What "Track with git" would write, so the dialog shows exactly that
        # rather than a copy of it. None once there is nothing to offer, and
        # when the folder has an ignore file of its own, which init keeps.
        "gitignore": (
            vcs_init.DEFAULT_GITIGNORE
            if state in (STATE_UNTRACKED, STATE_IGNORED)
            and not (workspace.path / ".gitignore").exists()
            else None
        ),
    }
    if repo is None:
        return payload
    payload.update(repo.as_dict())
    payload.pop("ignored")
    if state == STATE_READY:
        try:
            payload["changed"] = len(vcs_status.changes(repo))
            payload["head"] = vcs_repo.head(repo)
        except GitError as problem:
            raise _failure(problem) from problem
    return payload


@router.get("/versions/{id}/vcs/")
def get_vcs_status(workspace: Workspace = Depends(get_workspace)) -> dict:
    """The one poll: which state the folder is in, and how much has changed."""
    return _status_payload(workspace)


@router.get("/versions/{id}/vcs/changes/")
def list_changes(workspace: Workspace = Depends(get_workspace)) -> dict:
    repo = _ready(workspace)
    try:
        return {
            "head": vcs_repo.head(repo),
            "files": [entry.as_dict() for entry in vcs_status.changes(repo)],
        }
    except GitError as problem:
        raise _failure(problem) from problem


@router.get("/versions/{id}/vcs/log/")
def list_commits(
    limit: int = Query(vcs_log.DEFAULT_LIMIT, ge=1, le=500),
    path: str | None = Query(None),
    workspace: Workspace = Depends(get_workspace),
) -> dict:
    """The commits that touched the folder, or one file in it, newest first."""
    repo = _ready(workspace)
    relative = _relative(workspace, path) if path else None
    try:
        commits = vcs_log.log(repo, limit=limit, path=relative)
    except GitError as problem:
        raise _failure(problem) from problem
    return {"commits": [entry.as_dict() for entry in commits]}


@router.get("/versions/{id}/vcs/commits/{sha}/")
def get_commit(sha: str, workspace: Workspace = Depends(get_workspace)) -> dict:
    """One commit: what it says, and which of the folder's files it changed."""
    repo = _ready(workspace)
    info = vcs_log.commit_info(repo, _sha(sha))
    if info is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="No such commit."
        )
    try:
        return {
            "commit": info.as_dict(),
            "parent": vcs_log.parent(repo, info.sha),
            "files": vcs_log.commit_files(repo, info.sha),
        }
    except GitError as problem:
        raise _failure(problem) from problem


@router.get("/versions/{id}/vcs/diff/")
def get_diff(
    path: str = Query(...),
    sha: str | None = Query(None),
    workspace: Workspace = Depends(get_workspace),
) -> dict:
    """Both sides of one file: the working tree against HEAD, or one commit
    against its parent."""
    repo = _ready(workspace)
    relative = _relative(workspace, path)
    try:
        found = (
            vcs_diff.commit_diff(repo, _sha(sha), relative)
            if sha
            else vcs_diff.working_diff(repo, relative)
        )
    except GitError as problem:
        raise _failure(problem) from problem
    return found.as_dict()


@router.post("/versions/{id}/vcs/init/")
def init_repository(workspace: Workspace = Depends(get_workspace)) -> dict:
    """Puts the folder under version control, with a first commit."""
    if not git_available():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail=NOT_READY[STATE_NO_GIT]
        )
    try:
        vcs_init.init(workspace.path)
    except vcs_init.AlreadyTracked as problem:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail=str(problem)
        ) from None
    except GitError as problem:
        raise _failure(problem) from problem
    return _status_payload(workspace)


@router.post("/versions/{id}/vcs/commit/")
def create_commit(
    body: CommitBody, workspace: Workspace = Depends(get_workspace)
) -> dict:
    repo = _ready(workspace)
    paths = (
        [_relative(workspace, path, writable=True) for path in body.paths]
        if body.paths
        else None
    )
    try:
        sha = vcs_commit.commit(repo, paths, body.message)
    except GitError as problem:
        raise _failure(problem) from problem
    return {"sha": sha, "short": sha[:7]}


@router.post("/versions/{id}/vcs/discard/", status_code=status.HTTP_204_NO_CONTENT)
def discard_changes(
    body: DiscardBody, workspace: Workspace = Depends(get_workspace)
) -> None:
    """Puts one file back to how HEAD has it. The only destructive verb."""
    repo = _ready(workspace)
    relative = _relative(workspace, body.path, writable=True)
    try:
        changed = {entry.path for entry in vcs_status.changes(repo)}
        if relative not in changed:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="That file has no changes to discard.",
            )
        vcs_discard.discard(repo, relative)
    except GitError as problem:
        raise _failure(problem) from problem
