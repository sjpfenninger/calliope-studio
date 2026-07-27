"""Calliope Studio — a web UI for defining, running and analysing Calliope models.

The package is split into four layers, with a strict import direction:

- `calliope_studio.results` — reads solved models (`.nc`) and turns them into Arrow
  record batches. No web framework imports; usable directly from a notebook.
- `calliope_studio.modeldef` — reads and writes Calliope model definitions (YAML with
  comments preserved, CSV data tables). No web framework imports.
- `calliope_studio.runs` — builds and solves models in a subprocess, streaming logs
  and writing `results.nc`.
- `calliope_studio.server` — the FastAPI application. The only layer that may import
  `fastapi`, and the only one that knows about HTTP.

The server exposes *data*, never figures: all chart construction lives in the
Vue frontend under `web/`. Nothing here may import a plotting library.
"""

__all__ = ["__version__"]


def __getattr__(name: str):
    """Lazily expose the version so importing the package stays cheap."""
    if name == "__version__":
        from importlib.metadata import PackageNotFoundError, version

        try:
            return version("calliope-studio")
        except PackageNotFoundError:  # running from a source tree without metadata
            return "0.0.0"
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
