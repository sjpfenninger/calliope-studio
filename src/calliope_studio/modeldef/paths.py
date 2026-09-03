"""Workspace-relative path handling, with traversal guards.

Every path that reaches the filesystem from a request goes through
`safe_path`. There is no second line of defence.
"""

import hashlib
import os
import shutil
import tempfile
from pathlib import Path

#: Names never shown in the file tree, matched against any path component.
#:
#: `calliope-studio` is where run outputs go
#: (`server.storage.WORKSPACE_DATA_DIR`). It is deliberately a visible directory
#: so the user can find their results, but it is not part of the model
#: definition, so the editor's file tree hides it — which does mean a folder a
#: user genuinely named `calliope-studio` would be hidden too.
#:
#: `calligraph` and `.calligraph` are the names used before this project was
#: renamed (and, for the hidden one, before that). Both are kept so that a
#: workspace which escaped migration does not suddenly start showing run
#: artefacts; see `server.storage.LEGACY_WORKSPACE_DATA_DIRS`.
EXCLUDED_NAMES: frozenset[str] = frozenset(
    {
        ".DS_Store",
        ".git",
        ".gitignore",
        "calliope-studio",
        "calligraph",
        ".calligraph",
        "__pycache__",
        ".env",
        "node_modules",
        "Thumbs.db",
    }
)


def _replace_atomically(path: Path, write: "object") -> None:
    """Runs `write(fd)` into a sibling temporary file, then renames it over `path`.

    Every writer of a user's model definition goes through this. `runs.protocol`
    has its own copy for the run registry, with the reason that applies here
    too: a file lost to a crash or a full disk part-way through a write is not
    recoverable from anywhere, and until now the user's `techs.yaml` was
    truncated and rewritten in place.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        write(fd)  # type: ignore[operator]
        _copy_mode(path, tmp)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def _copy_mode(original: Path, tmp: str) -> None:
    """Gives the replacement the permission bits the original had.

    `mkstemp` creates its file 0600, and `os.replace` keeps the temporary's
    inode — so the first save through the app turned a 0644 `techs.yaml` into
    one nobody else on the machine could read, and every save after kept it
    that way. A file being created fresh gets what `open` would have given it.
    """
    try:
        shutil.copymode(original, tmp)
    except OSError:
        umask = os.umask(0)
        os.umask(umask)
        os.chmod(tmp, 0o666 & ~umask)


def content_revision(path: Path) -> str | None:
    """A short digest of a file's bytes, for a write to name what it was based on.

    This is the precondition every write route checks. A read hands it to the
    client; a save carries it back; if the file on disk has changed in between —
    another tab, another browser, an editor outside the app — the save is refused
    rather than silently reverting whatever landed in the meantime. Content
    rather than mtime, because an mtime has one-second resolution on some
    filesystems and survives a copy unchanged.

    Returns:
        The digest, or None if there is no file to digest.
    """
    try:
        data = Path(path).read_bytes()
    except OSError:
        return None
    return hashlib.sha256(data).hexdigest()[:16]


def write_text_atomic(path: Path, text: str) -> None:
    """Replaces a text file atomically, as UTF-8, with newlines untranslated.

    The encoding is explicit for the reason `deps.require_text` gives: without
    it Python uses the locale default, so on a Western Windows box a save wrote
    cp1252 bytes that the next read — which *does* say utf-8 — turned into
    replacement characters, and the save after that wrote the replacements.
    """

    def write(fd: int) -> None:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as fh:
            fh.write(text)

    _replace_atomically(path, write)


def write_bytes_atomic(path: Path, data: bytes) -> None:
    """Replaces a binary file atomically. For writers that pin their own bytes."""

    def write(fd: int) -> None:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)

    _replace_atomically(path, write)


class UnsafePath(ValueError):
    """Raised when a requested path escapes its workspace."""


def safe_path(base: Path, relative: str) -> Path:
    """Resolves `relative` inside `base`, rejecting traversal.

    Args:
        base: Workspace root.
        relative: Untrusted path from a request.

    Returns:
        The resolved absolute path, guaranteed to be within `base`.

    Raises:
        UnsafePath: If the resolved path falls outside `base`.
    """
    root = Path(base).resolve()
    candidate = (root / relative).resolve()
    # `is_relative_to` rather than string prefixing: the latter is wrong on
    # Windows and mishandles sibling directories that share a name prefix.
    if candidate != root and not candidate.is_relative_to(root):
        raise UnsafePath(relative)
    return candidate


def is_excluded(relative: Path) -> bool:
    """Whether any component of a workspace-relative path is excluded."""
    return any(part in EXCLUDED_NAMES for part in relative.parts) or any(
        part.endswith(".pyc") for part in relative.parts
    )


#: Extensions the frontend renders as a picture rather than as text.
#:
#: SVG is in here rather than with the text kinds because a user opening one
#: wants to see the drawing. It is served as `image/svg+xml` and drawn through
#: an `<img>`, which cannot run script, so treating it as an image is safe.
IMAGE_SUFFIXES: frozenset[str] = frozenset(
    {".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".ico", ".svg"}
)

MARKDOWN_SUFFIXES: frozenset[str] = frozenset({".md", ".markdown"})

#: Extensions known not to be text. Deliberately not exhaustive — it cannot be,
#: which is why `read_file` sniffs for a NUL byte as well. This list only exists
#: so the common cases get the right icon and skip the text request entirely.
BINARY_SUFFIXES: frozenset[str] = frozenset(
    {
        ".nc",
        ".h5",
        ".hdf5",
        ".zip",
        ".gz",
        ".tar",
        ".xz",
        ".7z",
        ".parquet",
        ".feather",
        ".xlsx",
        ".xls",
        ".ods",
        ".db",
        ".sqlite",
        ".sqlite3",
        ".pdf",
        ".pkl",
        ".npy",
        ".npz",
        ".woff",
        ".woff2",
        ".ttf",
        ".otf",
        ".so",
        ".dylib",
        ".dll",
        ".exe",
    }
)


def file_type(name: str) -> str:
    """Classifies a file for the frontend's file tree icons.

    Kept in step with `web/src/lib/fileKind.ts`, which answers the same question
    for the *renderer*. The duplication is deliberate: a tab restored from a
    `?tab=` URL is created before the file tree has been fetched, so the client
    cannot wait for this answer. `tests/test_paths.py` and `fileKind.test.ts`
    cover the same table on both sides.
    """
    suffix = Path(name).suffix.lower()
    if suffix in (".yaml", ".yml"):
        return "yaml"
    if suffix == ".csv":
        return "csv"
    if suffix in MARKDOWN_SUFFIXES:
        return "markdown"
    if suffix in IMAGE_SUFFIXES:
        return "image"
    if suffix in BINARY_SUFFIXES:
        return "binary"
    return "other"


def walk_files(base: Path) -> list[dict]:
    """Lists every non-excluded file and directory in a workspace, by path.

    Directories are listed in their own right, not merely implied by the files
    under them. The tree the frontend builds used to synthesise a folder from
    the `/` in a file's path, which meant an *empty* folder could not be
    represented at all — and so could not be created.
    """
    root = Path(base)
    if not root.is_dir():
        return []

    entries = []
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root)
        if is_excluded(relative):
            continue
        # POSIX, always. This is what the frontend keys on and splits on "/" —
        # `lib/fileTree.ts`, `lib/modelPaths.ts`, `stores/tabs.ts` and
        # `api/paths.ts` all do it unconditionally — so a Windows `str()` here
        # would collapse the whole tree into a flat list of `techs\supply.yaml`.
        as_key = relative.as_posix()
        if path.is_dir():
            entries.append({"path": as_key, "type": "directory"})
        elif path.is_file():
            entries.append(
                {
                    "path": as_key,
                    "type": file_type(path.name),
                    "size": path.stat().st_size,
                }
            )
    return entries


def yaml_files(base: Path) -> list[Path]:
    """Every non-excluded YAML file in a workspace, sorted and deduplicated."""
    root = Path(base)
    found = {
        path
        for pattern in ("*.yaml", "*.yml")
        for path in root.rglob(pattern)
        if path.is_file() and not is_excluded(path.relative_to(root))
    }
    return sorted(found)
