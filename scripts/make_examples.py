"""Solves Calliope's built-in example models into the sample `.nc` files.

`tests/test_oracle.py` is the only numerical evidence that the results layer
agrees with v0.2.0, and it *skips* when the models it compares on are absent —
which was every fresh clone and every CI run, because the files were placed by
hand and are gitignored. They are two `calliope` CLI invocations away, so
generating them costs a minute and removes the skip.

Naming is deliberately version-free (`national_scale.nc`, not
`national_scale_07.dev7.nc`). The hand-placed files carry a version in the name
and one of them is wrong about it — `urban_scale_07.dev7.nc` was initialised
with 0.7.0.dev6 — so a name is not evidence of what produced a file. What was
used is recorded in `generated.json` instead, per file, and a mismatch against
the installed Calliope regenerates rather than being quietly kept. The
version-stamped files stay where they are: they cannot be regenerated, and
their differing unit attrs are what `results/catalog.py` reads across Calliope
versions.

Run by `pixi run solve-examples`.
"""

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import calliope

REPO = Path(__file__).parent.parent

#: Where the tests look first, and the only place this script writes.
OUTPUT_DIR = REPO / "examples" / "nc_files"

#: Which Calliope produced each file beside it. Per file rather than one version
#: for the directory, because a run naming a single template must not vouch for
#: the others.
MANIFEST = OUTPUT_DIR / "generated.json"

#: Calliope ships exactly these two, and `calliope new --template` names them.
TEMPLATES = ["national_scale", "urban_scale"]


def output_path(template: str) -> Path:
    """Where `template`'s solved model is written."""
    return OUTPUT_DIR / f"{template}.nc"


def recorded_versions() -> dict[str, str]:
    """The manifest's file → Calliope version map, empty if there is none."""
    try:
        return json.loads(MANIFEST.read_text())["files"]
    except (OSError, KeyError, TypeError, json.JSONDecodeError):
        return {}


def current(templates: list[str]) -> list[str]:
    """Those of `templates` that exist and were solved by this Calliope."""
    versions = recorded_versions()
    return [
        template
        for template in templates
        if output_path(template).is_file()
        and versions.get(f"{template}.nc") == calliope.__version__
    ]


def solve(template: str, scratch: Path) -> None:
    """Scaffolds `template` under `scratch` and solves it into `OUTPUT_DIR`.

    Through the CLI rather than the API, because that is the path a user takes
    and each solve then gets its own process. `calliope new` refuses an existing
    target, which is why the model is scaffolded into a scratch directory rather
    than reusing `example-model/`; `--fail_when_infeasible` is the default, so a
    solve that does not reach optimality exits non-zero here rather than leaving
    a file behind that looks like a result.
    """
    model_dir = scratch / template
    subprocess.run(
        ["calliope", "new", str(model_dir), "--template", template], check=True
    )
    subprocess.run(
        [
            "calliope",
            "run",
            str(model_dir / "model.yaml"),
            "--save_netcdf",
            str(output_path(template)),
            "--quiet",
        ],
        check=True,
    )


def record(templates: list[str]) -> None:
    """Stamps this Calliope's version onto the files just written."""
    versions = recorded_versions()
    versions.update({f"{template}.nc": calliope.__version__ for template in templates})
    MANIFEST.write_text(
        json.dumps({"files": dict(sorted(versions.items()))}, indent=2) + "\n"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "templates",
        nargs="*",
        default=TEMPLATES,
        help=f"which example models to solve (default: {', '.join(TEMPLATES)})",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="solve again even when the files are already current",
    )
    arguments = parser.parse_args()

    templates = arguments.templates or TEMPLATES
    unknown = [name for name in templates if name not in TEMPLATES]
    if unknown:
        print(
            f"Unknown template(s): {', '.join(unknown)}. "
            f"Calliope ships {' and '.join(TEMPLATES)}.",
            file=sys.stderr,
        )
        return 2

    up_to_date = [] if arguments.force else current(templates)
    for template in up_to_date:
        print(f"{output_path(template).relative_to(REPO)}: current")

    wanted = [template for template in templates if template not in up_to_date]
    if not wanted:
        return 0

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="calliope-studio-examples-") as scratch:
        for template in wanted:
            # Flushed, or this lands after the subprocess output it introduces:
            # stdout is block-buffered into a CI log while `calliope` writes to
            # the same descriptor unbuffered.
            print(
                f"Solving {template} with Calliope {calliope.__version__}…", flush=True
            )
            try:
                solve(template, Path(scratch))
            except subprocess.CalledProcessError as error:
                print(f"\n{template}: {' '.join(error.cmd)} failed", file=sys.stderr)
                return 1
            # Recorded as each one lands, so a failure halfway through leaves a
            # manifest that is right about what did get solved.
            record([template])

    for template in wanted:
        path = output_path(template)
        print(f"{path.relative_to(REPO)}: {path.stat().st_size // 1024} kB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
