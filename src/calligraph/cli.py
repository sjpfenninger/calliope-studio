"""Command line entry point.

`calligraph <path>` starts the API, serves the built frontend from the same
process and opens a browser tab — the same shape as `jupyter lab`. There is no
separate server to run and no container to start.
"""

import os
import threading
import webbrowser
from pathlib import Path

import click

from calligraph.server.app import WORKSPACE_ENV_VAR


@click.command()
@click.argument(
    "path", type=click.Path(exists=True, path_type=Path), required=False, default="."
)
@click.option("--host", default="127.0.0.1", show_default=True, help="Host to bind to.")
@click.option(
    "--port",
    default=8000,
    show_default=True,
    type=int,
    help="Port to bind to. Use 0 to pick a free port.",
)
@click.option("--browser/--no-browser", default=True, help="Open a browser on start.")
@click.option(
    "--reload",
    is_flag=True,
    help="Reload on code changes. For development of calligraph itself.",
)
def main(path: Path, host: str, port: int, browser: bool, reload: bool) -> None:
    """Explore a Calliope model.

    PATH is either a model definition folder to edit and run, or a solved
    `.nc` file to analyse. Defaults to the current directory.
    """
    import uvicorn

    # The app factory reads this, so it is also picked up under --reload, where
    # uvicorn imports the module in a fresh subprocess.
    os.environ[WORKSPACE_ENV_VAR] = str(path.resolve())

    if browser:
        _open_browser_when_ready(host, port)

    uvicorn.run(
        "calligraph.server.app:app", host=host, port=port, reload=reload, factory=False
    )


def _open_browser_when_ready(host: str, port: int, delay: float = 1.0) -> None:
    """Opens a browser tab shortly after the server starts.

    Uvicorn offers no "server ready" hook that survives `--reload`, so this is a
    plain delay. Worst case the first load races the server and the user hits
    refresh.
    """
    url = f"http://{host}:{port}/"
    threading.Timer(delay, lambda: webbrowser.open_new_tab(url)).start()


if __name__ == "__main__":
    main()
