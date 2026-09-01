"""What kind of YAML file each file in a workspace is.

Calliope has four different schemas — model definition, config, math, data table
— and the editor used to validate every `.yaml` in a workspace against the model
definition one, because that is the only thing `fileMatch: ["*.yaml"]` can mean.
A math file is not a model definition, so every key in it read as unknown.

The kinds are decided the way Calliope itself decides them, which is by **how a
file is referred to**, not by what is in it or what it is called. `snapshot.py`
already had to work this out — a snapshot missing any of the three naming routes
is not a buildable model — so the routes are reused from there rather than
guessed at again here:

- `import:` chains reach the model definition, via `imports.reachable_files`;
- `config.init.math_paths` names math, and is invisible to the import graph.
  `urban_scale` refers to `additional_math.yaml` this way and no other.

Data tables need no kind of their own. `data_tables[*].table` points at CSVs, and
the `data_tables:` *section* is already a property of the model-definition
schema, so a YAML file never is one.

`unknown` is not a failure. A file being drafted before it is imported is the
normal state of one being written, and the honest answer for it is that we do not
know what it is meant to be — which is why the editor lets the user say.
"""

from pathlib import Path

from calliope_studio.modeldef.imports import find_model_yaml, reachable_files
from calliope_studio.modeldef.paths import yaml_files
from calliope_studio.modeldef.snapshot import math_paths, resolve_math_path
from calliope_studio.modeldef.yaml_io import load_quietly

#: A file the model definition reaches through `import:`, including the entry
#: point. Validated against Calliope's model-definition schema.
MODEL = "model"

#: A file named in `config.init.math_paths`. Validated against the math schema.
MATH = "math"

#: In the workspace, but nothing refers to it. No schema is applied.
UNKNOWN = "unknown"


def classify(base: Path) -> dict[str, str]:
    """Maps every YAML file in a workspace to its kind.

    Args:
        base: The model definition folder.

    Returns:
        Workspace-relative POSIX path to one of `MODEL`, `MATH` or `UNKNOWN`.
        Every YAML file in the workspace appears, so a caller can tell "not
        referred to" from "not a file we have heard of".
    """
    root = Path(base).resolve()
    kinds: dict[str, str] = {
        _relative(path, root): UNKNOWN for path in yaml_files(root)
    }

    if find_model_yaml(root) is None:
        return kinds

    reachable = reachable_files(root)
    for path in reachable:
        kinds[_relative(path, root)] = MODEL

    # After the import pass, so that a file which is both imported *and* named as
    # math is called math: the math schema is the one that describes its contents,
    # and being reachable says only that Calliope will read it.
    for path in reachable:
        document = load_quietly(path)
        if not isinstance(document, dict):
            continue
        for name in math_paths(document):
            target = resolve_math_path(root, name)
            if target.is_file() and target.is_relative_to(root):
                kinds[_relative(target, root)] = MATH

    return kinds


def _relative(path: Path, root: Path) -> str:
    """A workspace-relative POSIX path, which is what the frontend keys on."""
    return Path(path).resolve().relative_to(root).as_posix()
