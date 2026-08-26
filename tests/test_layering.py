"""Guards for the layered architecture's import rules.

Three rules:

- `results`, `modeldef` and `runs` must stay importable without a web framework,
  so that they remain usable from a notebook and cannot grow HTTP concerns.
  Only `calliope_studio.server` may import `fastapi`.
- No layer may import a plotting library. The server exposes data, never
  figures; all charts are built in the frontend. Reintroducing a Python-side
  plotting library would also reintroduce the duplicated theme definitions that
  v0.2.0 had to keep in sync by hand.
- The three domain layers may not import *each other*. `server` may import all
  three and is the only place allowed to compose them.
- `results` may not import **Calliope** at all. That is stronger than the rules
  above and is what makes the layer version-tolerant: `calliope.read_netcdf`
  builds a `Model`, and a `Model` insists on math the installed version
  understands, so seven of this repository's eleven sample `.nc` files could not
  be opened at all. Reading a results file needs none of that.
"""

import pathlib
import re
import subprocess
import sys

SRC = pathlib.Path(__file__).parent.parent / "src" / "calliope_studio"

#: Layers that must not depend on the web framework.
DOMAIN_LAYERS = ("results", "modeldef", "runs")

WEB_FRAMEWORKS = ("fastapi", "starlette", "uvicorn")

#: Banned everywhere, including in `server`.
PLOTTING_LIBRARIES = ("panel", "param", "plotly", "bokeh", "matplotlib", "altair")

IMPORT_RE = re.compile(r"^\s*(?:import|from)\s+([a-zA-Z0-9_]+)", re.MULTILINE)

#: Captures the layer in `from calliope_studio.<layer> import ...`. The rule above
#: cannot use `IMPORT_RE`, which only ever sees the leading `calliope_studio`.
PACKAGE_IMPORT_RE = re.compile(
    r"^\s*(?:from|import)\s+calliope_studio\.([a-zA-Z0-9_]+)", re.MULTILINE
)


def _imported_top_level_modules(path: pathlib.Path) -> set[str]:
    return set(IMPORT_RE.findall(path.read_text()))


def _imported_layers(path: pathlib.Path) -> set[str]:
    return set(PACKAGE_IMPORT_RE.findall(path.read_text()))


def _python_files(*relative_dirs: str):
    for relative in relative_dirs:
        directory = SRC / relative
        if directory.is_dir():
            yield from directory.rglob("*.py")


class TestImportRules:
    def test_domain_layers_do_not_import_a_web_framework(self):
        violations = []
        for path in _python_files(*DOMAIN_LAYERS):
            bad = _imported_top_level_modules(path) & set(WEB_FRAMEWORKS)
            if bad:
                violations.append(f"{path.relative_to(SRC)}: imports {sorted(bad)}")
        assert not violations, "\n".join(violations)

    def test_domain_layers_do_not_import_each_other(self):
        """The third rule above, previously unchecked.

        Snapshotting a model definition made this live: freezing needs
        `modeldef`, and it happens as part of starting a run, so the tempting
        shortcut is `runs.manager` importing `modeldef.snapshot`. The snapshot is
        injected from `server` as a callback instead, and this test is what keeps
        it that way.
        """
        violations = []
        for layer in DOMAIN_LAYERS:
            for path in _python_files(layer):
                bad = _imported_layers(path) & (set(DOMAIN_LAYERS) - {layer})
                if bad:
                    violations.append(f"{path.relative_to(SRC)}: imports {sorted(bad)}")
        assert not violations, "\n".join(violations)

    def test_results_does_not_import_calliope(self):
        """`results` reads a `.nc` structurally, so any Calliope is readable.

        The moment this import comes back, a user's file written by a different
        Calliope stops opening — which is exactly how it was: `ModelError:
        Requested math 'base' was not initialised` for every file older than
        0.7.0.dev7. It is also what lets the layer be used from a notebook that
        has no Calliope installed, which is its stated purpose.

        `runs` legitimately imports Calliope, and `server` composes both, so the
        rule is deliberately narrower than the layer rules above.
        """
        offenders = {
            path.name
            for path in _python_files("results")
            if "calliope" in _imported_top_level_modules(path)
        }

        assert offenders == set()

    def test_no_layer_imports_a_plotting_library(self):
        violations = []
        for path in SRC.rglob("*.py"):
            bad = _imported_top_level_modules(path) & set(PLOTTING_LIBRARIES)
            if bad:
                violations.append(f"{path.relative_to(SRC)}: imports {sorted(bad)}")
        assert not violations, "\n".join(violations)

    def test_importing_domain_layers_does_not_load_a_web_framework(self):
        """Catches transitive imports that the source-level scan cannot see."""
        code = (
            "import sys; "
            "import calliope_studio.results, calliope_studio.modeldef, calliope_studio.runs; "
            f"banned = set({WEB_FRAMEWORKS!r}) & set(sys.modules); "
            "assert not banned, f'web framework imported: {banned}'"
        )
        subprocess.run([sys.executable, "-c", code], check=True)
