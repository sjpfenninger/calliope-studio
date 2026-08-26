"""Fails if a built distribution does not contain the user interface.

The frontend is compiled into the Python package by a separate step, and
`python -m build` on its own succeeds without it — producing a distribution that
installs, starts, serves the API, and has no interface at all. Nothing about
that failure is visible until someone opens a browser.

**Both artefacts are checked, and the sdist is the one that was missing.**
conda-forge does not build from the wheel; it builds from the PyPI sdist. So an
sdist made without `web-build` passed this gate happily and would have produced
a conda package serving a blank page to everyone who installed it that way —
which, since the conda route is the one that brings a solver, is the route this
project most wants people to take.

Run by `pixi run build` after the artefacts are made.
"""

import sys
import tarfile
import zipfile
from pathlib import Path

STATIC_PREFIX = "calliope_studio/server/static/"
REQUIRED = STATIC_PREFIX + "index.html"

#: A bundle with only an index page means the build produced no assets.
MINIMUM_STATIC_FILES = 5


def _wheel_names(path: Path) -> list[str]:
    with zipfile.ZipFile(path) as archive:
        return archive.namelist()


def _sdist_names(path: Path) -> list[str]:
    """Member names with the sdist's leading `calliope_studio-<version>/` gone.

    An sdist wraps everything in one directory named after the release, so its
    paths cannot be compared with a wheel's until that is stripped. The layout
    inside is the *source* one — `src/calliope_studio/...` — not the installed
    one, which is why the prefixes below are built rather than shared.
    """
    with tarfile.open(path) as archive:
        members = archive.getnames()
    stripped = []
    for name in members:
        head, _, tail = name.partition("/")
        stripped.append(tail if tail else head)
    return stripped


def check(path: Path) -> list[str]:
    """Returns the problems found in one built artefact.

    Args:
        path: A `.whl` or a `.tar.gz` in `dist/`.
    """
    if path.name.endswith(".whl"):
        names = _wheel_names(path)
        required, prefix = REQUIRED, STATIC_PREFIX
    else:
        names = _sdist_names(path)
        required, prefix = f"src/{REQUIRED}", f"src/{STATIC_PREFIX}"

    problems = []
    if required not in names:
        problems.append(f"{path.name}: no interface — {required} is missing")

    static = [name for name in names if name.startswith(prefix)]
    if 0 < len(static) < MINIMUM_STATIC_FILES:
        problems.append(
            f"{path.name}: only {len(static)} bundled files, "
            "which suggests an incomplete frontend build"
        )
    return problems


def main() -> int:
    dist = Path("dist")
    wheels = sorted(dist.glob("*.whl"))
    sdists = sorted(dist.glob("*.tar.gz"))
    if not wheels:
        print("No wheel found in dist/.", file=sys.stderr)
        return 1
    if not sdists:
        # Not a warning. conda-forge builds from the sdist, so an absent one is
        # a release that cannot take the route that ships a solver.
        print("No sdist found in dist/.", file=sys.stderr)
        return 1

    artefacts = wheels + sdists
    problems = [problem for path in artefacts for problem in check(path)]
    if problems:
        for problem in problems:
            print(problem, file=sys.stderr)
        print(
            "\nBuild the frontend first: pixi run web-build, or use pixi run build.",
            file=sys.stderr,
        )
        return 1

    for path in artefacts:
        print(f"{path.name}: interface bundled")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
