"""Guards for the layered architecture's import rules.

Two rules, both stated in CLAUDE.md:

- `results`, `modeldef` and `runs` must stay importable without a web framework,
  so that they remain usable from a notebook and cannot grow HTTP concerns.
  Only `calligraph.server` may import `fastapi`.
- No layer may import a plotting library. The server exposes data, never
  figures; all charts are built in the frontend. Reintroducing a Python-side
  plotting library would also reintroduce the duplicated theme definitions that
  v0.2.0 had to keep in sync by hand.
"""

import pathlib
import re
import subprocess
import sys

SRC = pathlib.Path(__file__).parent.parent / "src" / "calligraph"

#: Layers that must not depend on the web framework.
DOMAIN_LAYERS = ("results", "modeldef", "runs")

WEB_FRAMEWORKS = ("fastapi", "starlette", "uvicorn")

#: Banned everywhere, including in `server`.
PLOTTING_LIBRARIES = ("panel", "param", "plotly", "bokeh", "matplotlib", "altair")

IMPORT_RE = re.compile(r"^\s*(?:import|from)\s+([a-zA-Z0-9_]+)", re.MULTILINE)


def _imported_top_level_modules(path: pathlib.Path) -> set[str]:
    return set(IMPORT_RE.findall(path.read_text()))


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
            "import calligraph.results, calligraph.modeldef, calligraph.runs; "
            f"banned = set({WEB_FRAMEWORKS!r}) & set(sys.modules); "
            "assert not banned, f'web framework imported: {banned}'"
        )
        subprocess.run([sys.executable, "-c", code], check=True)
