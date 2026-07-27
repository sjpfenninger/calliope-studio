"""The cheap validation tier: can every YAML file in a workspace be parsed?

In-process and measured in milliseconds, which is what makes it usable on every
save. It lives here rather than in `runs` because it is purely a statement about
files on disk — no subprocess, no Calliope, no solver.

The two expensive tiers do need Calliope and so run in the worker subprocess; see
`calliope_studio.runs.validate` for interpreting their outcome.
"""

from pathlib import Path

from calliope_studio.modeldef.paths import yaml_files
from calliope_studio.modeldef.yaml_io import syntax_errors


def check_syntax(base: Path) -> dict:
    """Parses every YAML file in a workspace and collects syntax errors."""
    root = Path(base)
    errors: list[dict] = []
    for path in yaml_files(root):
        errors.extend(syntax_errors(path, str(path.relative_to(root))))
    return {"errors": errors}
