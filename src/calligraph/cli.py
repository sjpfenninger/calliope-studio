"""Command line entry point.

`calligraph <path>` starts the API, serves the built frontend from the same
process and opens a browser tab — the same shape as `jupyter lab`. There is no
separate server to run and no container to start.
"""

import os
import socket
import threading
import webbrowser
from pathlib import Path

import click

from calligraph.server.app import WORKSPACE_ENV_VAR

#: How far to scan upward from the requested port before giving up. Opening a
#: second model should not fail just because the first one is still running.
PORT_SCAN_ATTEMPTS = 20


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
    help="Port to bind to. The next free port is used if it is taken.",
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

    landing = describe_target(path)

    # The app factory reads this, so it is also picked up under --reload, where
    # uvicorn imports the module in a fresh subprocess.
    os.environ[WORKSPACE_ENV_VAR] = str(path.resolve())

    listener = bind_available(host, port)
    bound_port = listener.getsockname()[1]
    if bound_port != port:
        click.echo(f"Port {port} is in use; using {bound_port} instead.")
    click.echo(f"Calligraph is at http://{host}:{bound_port}{landing}")

    if browser:
        # The socket is already listening, so a request made now waits in the
        # accept queue rather than being refused. There is nothing to wait for.
        open_browser(f"http://{host}:{bound_port}{landing}")

    if reload:
        # The reloader supervises its own worker processes and binds its own
        # socket, so ours cannot be handed to it. Releasing it and passing the
        # number leaves a moment in which something else could take the port —
        # acceptable for a development-only flag, and not worth a worse design
        # everywhere else to avoid.
        listener.close()
        uvicorn.run(
            "calligraph.server.app:app", host=host, port=bound_port, reload=True
        )
        return

    server = uvicorn.Server(uvicorn.Config("calligraph.server.app:app"))
    server.run(sockets=[listener])


def describe_target(path: Path) -> str:
    """Checks that `path` is something to open, and says where to land.

    Delegates the decision to `server.mode.resolve_target`, which the application
    factory also uses. The two used to classify the target independently, so the
    URL the browser was sent to and what `/api/health` reported could disagree.

    Serving a directory with no model in it used to succeed and then show an empty
    file tree, which reads as a broken application rather than a mistyped path.

    Returns:
        The path within the app to open.

    Raises:
        click.ClickException: If there is nothing there to open.
    """
    from calligraph.server.mode import NotSomethingToOpen, resolve_target

    try:
        return resolve_target(path).landing
    except NotSomethingToOpen as problem:
        raise click.ClickException(str(problem)) from None


def bind_available(
    host: str, port: int, attempts: int = PORT_SCAN_ATTEMPTS
) -> socket.socket:
    """Returns a listening socket, scanning upward if the port is taken.

    Binding here rather than letting uvicorn do it is what makes the port
    knowable before the server starts, so the browser can be sent to the right
    place. A port of 0 asks the operating system to choose.

    Raises:
        click.ClickException: If no port in the scanned range is free.
    """
    for offset in range(attempts):
        candidate = 0 if port == 0 else port + offset
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        # Permits rebinding a port left in TIME_WAIT by a previous run. It does
        # not allow two live listeners, so this cannot mask a port genuinely in
        # use and silently produce a second server nobody can reach.
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            listener.bind((host, candidate))
            listener.listen()
            return listener
        except OSError:
            listener.close()
            if port == 0:
                raise

    raise click.ClickException(
        f"No free port between {port} and {port + attempts - 1} on {host}."
    )


def open_browser(url: str) -> None:
    """Opens a browser tab without blocking the server from starting."""
    threading.Thread(target=webbrowser.open_new_tab, args=(url,), daemon=True).start()


if __name__ == "__main__":
    main()
