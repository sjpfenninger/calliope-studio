"""Fails if a built wheel does not contain the user interface.

The frontend is compiled into the Python package by a separate step, and
`python -m build` on its own succeeds without it — producing a wheel that
installs, starts, serves the API, and has no interface at all. Nothing about
that failure is visible until someone opens a browser.

Run by `pixi run build` after the wheel is made.
"""

import sys
import zipfile
from pathlib import Path

REQUIRED = "calliope_studio/server/static/index.html"

#: A bundle with only an index page means the build produced no assets.
MINIMUM_STATIC_FILES = 5


def check(wheel: Path) -> list[str]:
    """Returns the problems found in one wheel."""
    with zipfile.ZipFile(wheel) as archive:
        names = archive.namelist()

    problems = []
    if REQUIRED not in names:
        problems.append(f"{wheel.name}: no interface — {REQUIRED} is missing")

    prefix = "calliope_studio/server/static/"
    static = [name for name in names if name.startswith(prefix)]
    if 0 < len(static) < MINIMUM_STATIC_FILES:
        problems.append(
            f"{wheel.name}: only {len(static)} bundled files, "
            "which suggests an incomplete frontend build"
        )
    return problems


def main() -> int:
    wheels = sorted(Path("dist").glob("*.whl"))
    if not wheels:
        print("No wheel found in dist/.", file=sys.stderr)
        return 1

    problems = [problem for wheel in wheels for problem in check(wheel)]
    if problems:
        for problem in problems:
            print(problem, file=sys.stderr)
        print(
            "\nBuild the frontend first: pixi run web-build, or use pixi run build.",
            file=sys.stderr,
        )
        return 1

    for wheel in wheels:
        print(f"{wheel.name}: interface bundled")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
