"""The cheap validation tier: can every YAML file in a workspace be parsed?

In-process and measured in milliseconds, which is what makes it usable on every
save. It lives here rather than in `runs` because it is purely a statement about
files on disk — no subprocess, no Calliope, no solver.

The expensive tier does need Calliope and so runs in the worker subprocess; see
`calliope_studio.runs.validate` for interpreting its outcome. The two are one
action to the user — this tier runs first and the build only follows a clean
result — so every problem carries the `tier` that found it, which is the only
thing that distinguishes them once they are in one list.
"""

from pathlib import Path

from calliope_studio.modeldef.paths import yaml_files
from calliope_studio.modeldef.yaml_io import syntax_errors

#: What this tier stamps on the problems it reports. The build tier's counterpart
#: is in `calliope_studio.runs.validate`.
TIER = "syntax"


def check_syntax(base: Path) -> dict:
    """Parses every YAML file in a workspace and collects syntax errors."""
    root = Path(base)
    errors: list[dict] = []
    for path in yaml_files(root):
        for error in syntax_errors(path, path.relative_to(root).as_posix()):
            errors.append({**error, "tier": TIER})
    return {"errors": errors}
