"""Browsing the filesystem, so a model can be opened without typing a path.

A browser cannot open a native folder dialog, and the only way to add a workspace
used to be typing an absolute path into a JSON API. For a localhost application a
small server-side folder browser is the honest fit.

Deliberately narrow. It lists **directory entries only** and never file contents,
so it cannot be used to read anything; reading goes through the workspace routes,
which are guarded by `safe_path`. It has no traversal guard of its own because it
has no root to escape — browsing the filesystem is the entire feature — which is
exactly why it must stay behind the local-only seam. A hosted deployment has to
withhold it, and `deps.get_storage` is where that decision belongs.
"""

from pathlib import Path

from fastapi import APIRouter, HTTPException, status

from calligraph.modeldef.imports import find_model_yaml
from calligraph.modeldef.paths import EXCLUDED_NAMES

router = APIRouter(tags=["browse"])

#: Cap on entries returned for one directory. A home directory with tens of
#: thousands of folders should not produce a response nobody can render.
MAX_ENTRIES = 500


@router.get("/browse/")
def browse(path: str | None = None) -> dict:
    """Lists the directories inside `path`, marking which contain a model.

    Args:
        path: Directory to list. Defaults to the user's home directory, which is
            where someone looking for their models is most likely to start.

    Returns:
        The resolved directory, its parent (null at the filesystem root), and its
        subdirectories with a flag for whether each is a Calliope model.
    """
    target = Path(path).expanduser() if path else Path.home()
    try:
        target = target.resolve()
    except OSError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid path."
        ) from None

    if not target.is_dir():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="No such directory."
        )

    try:
        children = sorted(
            (child for child in target.iterdir() if child.is_dir()),
            key=lambda child: child.name.lower(),
        )
    except OSError:
        # An unreadable directory is a normal thing to click on, not an error
        # worth failing the request over — show it as empty.
        children = []

    # `EXCLUDED_NAMES` is about what belongs to a *model definition*, and it is
    # the right rule inside a model folder — `calligraph/` there is this
    # application's own output. Applied everywhere it is wrong: any folder on the
    # machine called `calligraph` would become unreachable, including the one
    # this project is developed in. So it only applies where it means something.
    listing_a_model = find_model_yaml(target) is not None

    def hidden(child: Path) -> bool:
        if child.name.startswith("."):
            return True
        return listing_a_model and child.name in EXCLUDED_NAMES

    entries = [
        {
            "name": child.name,
            "path": str(child),
            # What the dialog needs in order to offer "open" rather than
            # "create a model here".
            "is_model": find_model_yaml(child) is not None,
        }
        for child in children
        if not hidden(child)
    ]

    return {
        "path": str(target),
        # Null at the root, so the dialog knows not to offer "up".
        "parent": str(target.parent) if target.parent != target else None,
        "is_model": listing_a_model,
        "entries": entries[:MAX_ENTRIES],
        "truncated": len(entries) > MAX_ENTRIES,
    }
