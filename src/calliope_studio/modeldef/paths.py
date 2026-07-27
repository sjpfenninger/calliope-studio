"""Workspace-relative path handling, with traversal guards.

Every path that reaches the filesystem from a request goes through
`safe_path`. There is no second line of defence.
"""

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


def file_type(name: str) -> str:
    """Classifies a file for the frontend's file tree icons."""
    suffix = Path(name).suffix.lower()
    if suffix in (".yaml", ".yml"):
        return "yaml"
    if suffix == ".csv":
        return "csv"
    return "other"


def walk_files(base: Path) -> list[dict]:
    """Lists every non-excluded file in a workspace, sorted by path."""
    root = Path(base)
    if not root.is_dir():
        return []

    entries = []
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        relative = path.relative_to(root)
        if is_excluded(relative):
            continue
        entries.append(
            {
                "path": str(relative),
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
