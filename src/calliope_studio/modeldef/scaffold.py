"""Creating a new model definition from one of Calliope's built-in examples.

This is `calliope new`, in process. That command is a `shutil.copytree` from
Calliope's `example_models` directory and nothing else, so shelling out to it
would buy only a subprocess, a dependency on the `calliope` script being on
PATH, and errors that arrive as text to be parsed rather than as exceptions.

It lives in `modeldef` because a model definition on disk is what it produces —
and because `server` may import `modeldef`, which is what lets the route
compose "scaffold, then register as a workspace".
"""

import importlib.resources
import shutil
from pathlib import Path

from calliope_studio.modeldef.imports import find_model_yaml

#: Where Calliope keeps the templates `calliope new --template` names.
#:
#: Built the same way `calliope.examples` builds its own `_EXAMPLE_MODEL_DIR`,
#: rather than importing that private name — and rather than hard-coding the two
#: template names, so a Calliope release that adds one needs no change here.
TEMPLATE_DIR = Path(str(importlib.resources.files("calliope"))) / "example_models"

#: What `calliope new` uses when `--template` is not given.
DEFAULT_TEMPLATE = "national_scale"


def available_templates() -> list[str]:
    """Lists the model templates that can be copied.

    Returns:
        Template names, sorted. Empty if Calliope ships no example models.
    """
    if not TEMPLATE_DIR.is_dir():
        return []
    return sorted(entry.name for entry in TEMPLATE_DIR.iterdir() if entry.is_dir())


def create_model(parent: Path, name: str, template: str = DEFAULT_TEMPLATE) -> Path:
    """Copies a template into a new folder inside `parent`.

    Args:
        parent: Existing directory to create the model folder in.
        name: Name of the folder to create. A single path segment.
        template: Which built-in example to copy.

    Returns:
        The created model folder.

    Raises:
        NotADirectoryError: `parent` is not an existing directory.
        ValueError: `name` is not a usable single path segment, or `template`
            is not one Calliope ships.
        FileExistsError: The target already exists. Calliope's own rule — the
            copy is not a merge, and refusing is what stops a mistyped name
            from scattering a template over someone's existing model.
    """
    root = Path(parent).expanduser().resolve()
    if not root.is_dir():
        raise NotADirectoryError(f"Not a directory: {parent}")

    folder = name.strip()
    if not folder:
        raise ValueError("A model needs a name.")
    # A name is a folder name, not a path: `../elsewhere` would otherwise create
    # a model outside the folder the user is looking at.
    if folder in {".", ".."} or "/" in folder or "\\" in folder:
        raise ValueError(f"Not a folder name: {name}")
    if folder.startswith("."):
        raise ValueError("A model folder starting with a dot would be hidden.")

    if template not in available_templates():
        raise ValueError(f"No such template: {template}")

    target = root / folder
    if target.exists():
        raise FileExistsError(f"Already exists: {target}")

    shutil.copytree(TEMPLATE_DIR / template, target)

    if find_model_yaml(target) is None:  # pragma: no cover - a broken template
        raise ValueError(f"The {template} template has no model.yaml.")
    return target
