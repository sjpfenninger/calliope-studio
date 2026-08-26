"""Command line entry point.

`calliope-studio <path>` starts the API, serves the built frontend from the same
process and opens a browser tab — the same shape as `jupyter lab`. There is no
separate server to run and no container to start.
"""

import os
import socket
import threading
import webbrowser
from pathlib import Path

import click

from calliope_studio.server.app import WORKSPACE_ENV_VAR

#: How far to scan upward from the requested port before giving up. Opening a
#: second model should not fail just because the first one is still running.
PORT_SCAN_ATTEMPTS = 20


#: Where the frontend lands when nothing was opened — the recents-and-create
#: screen. `server/mode.py` already reports it as the landing for
#: `mode: "unknown"`; this is the same string, and the one place the CLI needs
#: to know it.
PICKER_LANDING = "/projects"


@click.command()
@click.argument(
    "path", type=click.Path(exists=True, path_type=Path), required=False, default=None
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
    help="Reload on code changes. For development of Calliope Studio itself.",
)
@click.option(
    "-v",
    "--verbose",
    is_flag=True,
    help="Show request logs and uvicorn's own startup output.",
)
def main(
    path: Path | None, host: str, port: int, browser: bool, reload: bool, verbose: bool
) -> None:
    """Explore a Calliope model.

    PATH is either a model definition folder to edit and run, or a solved
    `.nc` file to analyse. With no PATH, Calliope Studio opens the model picker.
    """
    import uvicorn

    landing = describe_target(path)

    # The app factory reads this, so it is also picked up under --reload, where
    # uvicorn imports the module in a fresh subprocess. Cleared rather than left
    # when there is nothing to open: a stale value from an earlier invocation in
    # the same shell would silently reopen the wrong model.
    if path is None:
        os.environ.pop(WORKSPACE_ENV_VAR, None)
    else:
        os.environ[WORKSPACE_ENV_VAR] = str(path.resolve())

    listener = bind_available(host, port)
    bound_port = listener.getsockname()[1]
    if bound_port != port:
        click.echo(f"Port {port} is in use; using {bound_port} instead.")
    click.echo(f"Calliope Studio is at http://{host}:{bound_port}{landing}")

    if browser:
        # The socket is already listening, so a request made now waits in the
        # accept queue rather than being refused. There is nothing to wait for.
        open_browser(f"http://{host}:{bound_port}{landing}")

    # Quiet by default: the line above already says where the app is, and a
    # request log for every asset, status poll and Arrow frame buries anything
    # that actually needs reading. Warnings and tracebacks still come through.
    # `--reload` is for developing Calliope Studio itself, where the reloader's own
    # notices are the point, so it implies verbosity.
    verbose = verbose or reload
    log_level = "info" if verbose else "warning"

    if reload:
        # The reloader supervises its own worker processes and binds its own
        # socket, so ours cannot be handed to it. Releasing it and passing the
        # number leaves a moment in which something else could take the port —
        # acceptable for a development-only flag, and not worth a worse design
        # everywhere else to avoid.
        listener.close()
        uvicorn.run(
            "calliope_studio.server.app:app",
            host=host,
            port=bound_port,
            reload=True,
            log_level=log_level,
            access_log=verbose,
        )
        return

    server = uvicorn.Server(
        uvicorn.Config(
            "calliope_studio.server.app:app", log_level=log_level, access_log=verbose
        )
    )
    server.run(sockets=[listener])


def describe_target(path: Path | None) -> str:
    """Checks that `path` is something to open, and says where to land.

    Delegates the decision to `server.mode.resolve_target`, which the application
    factory also uses. The two used to classify the target independently, so the
    URL the browser was sent to and what `/api/health` reported could disagree.

    Serving a directory with no model in it used to succeed and then show an empty
    file tree, which reads as a broken application rather than a mistyped path.

    **No argument and a wrong argument are different things**, which is the whole
    of the picker mode. An absent PATH means "I did not say", and the honest
    answer is the list of models you have opened; a PATH that is not a model
    means "I said, and I was wrong", and silently showing the picker instead
    would hide a typo. Click gives the distinction for free now that the default
    is None rather than `"."`, which conflated the two — a bare `calliope-studio`
    was indistinguishable from someone naming the working directory, so it
    failed wherever that happened not to be a model.

    Returns:
        The path within the app to open.

    Raises:
        click.ClickException: If a path was given and there is nothing there.
    """
    from calliope_studio.server.mode import NotSomethingToOpen, resolve_target

    if path is None:
        return PICKER_LANDING

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
        if os.name != "nt":
            # Permits rebinding a port left in TIME_WAIT by a previous run. It
            # does not allow two live listeners, so this cannot mask a port
            # genuinely in use and silently produce a second server nobody can
            # reach.
            #
            # Not on Windows, where the same flag means very nearly the
            # opposite: it permits binding over a *live* listener, so the scan
            # below would never advance past the first port and two servers
            # would both hold 8000, with delivery between them arbitrary.
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
