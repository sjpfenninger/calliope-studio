"""History: the commits that touched the folder, and what each one changed.

`git log` is asked for a format joined on the ASCII unit separator and records
split on NUL, so nothing a commit subject can contain needs escaping or a
guard on how many fields came back — the reason tolaria's `|`-delimited
format needs a `splitn`, and this does not.
"""

from __future__ import annotations

from dataclasses import dataclass

from calliope_studio.vcs.command import git, run
from calliope_studio.vcs.repo import Repo, head
from calliope_studio.vcs.status import state_of

#: Full sha, short sha, author, ISO date, subject.
FORMAT = "%H%x1f%h%x1f%an%x1f%aI%x1f%s"

#: How many commits a listing returns unless asked otherwise.
DEFAULT_LIMIT = 50


@dataclass(frozen=True)
class Commit:
    sha: str
    short: str
    author: str
    date: str
    subject: str
    body: str = ""

    def as_dict(self) -> dict:
        return {
            "sha": self.sha,
            "short": self.short,
            "author": self.author,
            "date": self.date,
            "subject": self.subject,
            "body": self.body,
        }


def log(
    repo: Repo, *, limit: int = DEFAULT_LIMIT, path: str | None = None
) -> list[Commit]:
    """The newest `limit` commits touching the folder, or one file in it."""
    if head(repo) is None:
        return []
    spec = repo.relative(path) if path else repo.pathspec
    out = git(["log", f"--format={FORMAT}", "-z", f"-n{limit}", "--", spec], repo.root)
    return [_commit(record) for record in out.split("\0") if record]


def commit_info(repo: Repo, sha: str) -> Commit | None:
    """One commit with its body, or None if there is no such commit."""
    completed = run(
        ["show", "-s", f"--format={FORMAT}%x1f%b", sha, "--"], repo.root, check=False
    )
    if completed.returncode != 0:
        return None
    return _commit(completed.stdout.decode("utf-8", errors="replace").strip("\n"))


def parent(repo: Repo, sha: str) -> str | None:
    """The commit before this one, or None for the first commit."""
    completed = run(["rev-parse", "--verify", "-q", f"{sha}^"], repo.root, check=False)
    if completed.returncode != 0:
        return None
    return completed.stdout.decode("utf-8", errors="replace").strip()


def commit_files(repo: Repo, sha: str) -> list[dict]:
    """The files under the folder that a commit changed.

    `--name-status -z` writes a status token then the path, and for a rename
    the old path then the new one. The first commit lists everything as added,
    which is what `git show` does for a root commit on its own.
    """
    out = git(
        ["show", "--name-status", "-z", "--format=", sha, "--", repo.pathspec],
        repo.root,
    )
    tokens = [token for token in out.split("\0")]
    found: list[dict] = []
    position = 0
    while position < len(tokens):
        token = tokens[position]
        position += 1
        if not token:
            continue
        code = token[0]
        original: str | None = None
        if code in "RC":
            original = (
                repo.unrelative(tokens[position]) if position < len(tokens) else None
            )
            position += 1
        root_path = tokens[position] if position < len(tokens) else ""
        position += 1
        path = repo.unrelative(root_path)
        if path is None:
            continue
        found.append(
            {"path": path, "state": state_of(f"{code} "), "original": original}
        )
    return sorted(found, key=lambda entry: entry["path"])


def _commit(record: str) -> Commit:
    fields = record.split("\x1f")
    while len(fields) < 6:
        fields.append("")
    sha, short, author, date, subject, body = fields[:6]
    return Commit(
        sha=sha,
        short=short,
        author=author,
        date=date,
        subject=subject,
        body=body.strip(),
    )
