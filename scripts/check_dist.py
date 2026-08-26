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

Given a version argument it also asserts the artefacts carry it, which is the
release's guard against a different silent failure: setuptools-scm does not
raise when it cannot read git, it falls back to `fallback_version`. A release
job whose checkout lost its tags therefore builds `0.1.0.dev0`, uploads it
happily, and burns a version number that PyPI will never accept again. Nothing
in the build says anything is wrong, because from setuptools-scm's point of
view nothing is.

Run by `pixi run build` after the artefacts are made, and again by the release
workflow with the tag it is publishing.
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


def _metadata_version(path: Path) -> str | None:
    """The `Version:` field recorded inside an artefact, or None if absent.

    Read out of the metadata rather than parsed off the filename. The filename
    is *derived* from this field and normalised on the way, so the metadata is
    the thing that actually gets published and the thing worth asserting on.
    """
    if path.name.endswith(".whl"):
        with zipfile.ZipFile(path) as archive:
            names = [n for n in archive.namelist() if n.endswith(".dist-info/METADATA")]
            if not names:
                return None
            text = archive.read(names[0]).decode()
    else:
        with tarfile.open(path) as archive:
            # The top-level PKG-INFO, not one belonging to a nested egg-info.
            names = [
                n
                for n in archive.getnames()
                if n.count("/") == 1 and n.endswith("/PKG-INFO")
            ]
            if not names:
                return None
            handle = archive.extractfile(names[0])
            if handle is None:
                return None
            text = handle.read().decode()

    for line in text.splitlines():
        if not line.strip():
            break  # End of the headers; the long description follows.
        if line.startswith("Version:"):
            return line.split(":", 1)[1].strip()
    return None


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


def main(argv: list[str] | None = None) -> int:
    """Checks `dist/`, optionally against an expected version.

    Args:
        argv: Arguments after the program name. A single optional element, the
            version every artefact must declare — the release workflow passes
            the tag it is publishing, with the leading `v` stripped.
    """
    args = sys.argv[1:] if argv is None else argv
    if len(args) > 1:
        print(f"Usage: check_dist.py [expected-version]; got {args}", file=sys.stderr)
        return 2
    expected = args[0] if args else None

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

    if expected is not None:
        for path in artefacts:
            found = _metadata_version(path)
            if found is None:
                problems.append(f"{path.name}: no Version in its metadata")
            elif found != expected:
                problems.append(
                    f"{path.name}: declares version {found}, expected {expected}"
                )
    if problems:
        for problem in problems:
            print(problem, file=sys.stderr)
        if any(
            "interface" in problem or "bundled files" in problem for problem in problems
        ):
            print(
                "\nBuild the frontend first: pixi run web-build, or use pixi run build.",
                file=sys.stderr,
            )
        if any("expected" in problem for problem in problems):
            print(
                "\nsetuptools-scm falls back to `fallback_version` rather than "
                "failing when it cannot read git — check the checkout has tags.",
                file=sys.stderr,
            )
        return 1

    for path in artefacts:
        suffix = f", version {expected}" if expected is not None else ""
        print(f"{path.name}: interface bundled{suffix}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
