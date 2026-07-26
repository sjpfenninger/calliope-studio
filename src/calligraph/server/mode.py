"""What `calligraph <path>` was pointed at, and how the app should present it.

One decision function, used by both the CLI and the application factory. They
used to decide independently — `cli.describe_target` chose the landing URL and
`create_app` separately worked out whether it had a workspace, a results file or
neither — so the browser URL and `/api/health` could disagree about what was
open.

There are two modes, and the difference is not cosmetic: a bare `.nc` has no
model definition, so every `/api/versions/{id}/…` route is unreachable for it.
The frontend is told which mode it is in explicitly, rather than inferring it from
a null workspace id, because that conflated "opened a results file" with "opened a
folder that has no model in it".
"""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from calligraph.modeldef.imports import find_model_yaml
from calligraph.runs import protocol
from calligraph.server.storage import workspace_id


class NotSomethingToOpen(ValueError):
    """Raised when a path is neither a model folder nor a solved results file.

    Carries a message written for the person who typed the path.
    """


@dataclass(frozen=True)
class Target:
    """What was opened."""

    #: `"workspace"` — a model folder; everything works.
    #: `"results"` — a solved `.nc` on its own; analysis only.
    kind: Literal["workspace", "results"]
    #: The model folder, for a workspace; the `.nc`, for results.
    path: Path
    #: Where the frontend should land.
    landing: str
    #: The `.nc` to open, when there is one to open immediately.
    results_file: Path | None = None
    #: The run this `.nc` came from, when it can be recovered.
    run_id: str | None = None
    #: What the frontend may offer. A single place to gate future cases — a
    #: read-only hosted deployment, a workspace on a read-only mount — without
    #: inventing another `kind`.
    capabilities: dict = field(default_factory=dict)


def resolve_target(path: Path) -> Target:
    """Classifies what to open.

    Args:
        path: A model folder, or a solved model saved as `.nc`.

    Raises:
        NotSomethingToOpen: If it is neither.
    """
    resolved = Path(path).resolve()

    if resolved.is_file():
        if resolved.suffix != ".nc":
            raise NotSomethingToOpen(
                f"{resolved} is not a Calliope results file.\n"
                "Give a solved model saved as '.nc', or a folder containing a "
                "model.yaml."
            )
        return _results_target(resolved)

    if find_model_yaml(resolved) is None:
        raise NotSomethingToOpen(
            f"No model.yaml in {resolved}.\n"
            "Give a folder containing a Calliope model, or a solved model saved "
            "as '.nc'.\n"
            # `calliope new` requires its target not to exist, so this suggests a
            # new folder rather than the one that was just rejected.
            "To create a model to work on, run 'calliope new <new-folder>'."
        )

    # Straight into the shell for the model that was asked for, rather than the
    # recent-models list: the user has already said which one they want, and the
    # list is for when nothing is open. The version is resolved client-side,
    # since only the API knows it.
    return Target(
        kind="workspace",
        path=resolved,
        landing=f"/projects/{workspace_id(resolved)}",
        capabilities=_capabilities(editable=True),
    )


def _results_target(results_file: Path) -> Target:
    """A `.nc`, which may turn out to be a run's output.

    A results file sitting next to a `request.json` *is* a run's output, so its
    owning workspace can be recovered from the request and the whole application
    opened on that run. That turns `calligraph calligraph/runs/<id>/results.nc`
    from the most crippled invocation into the best one.
    """
    run_dir = results_file.parent
    if (run_dir / protocol.REQUEST_FILE).is_file():
        try:
            request = protocol.RunRequest.read(run_dir)
            workspace = Path(request.workspace).resolve()
        except (OSError, ValueError, TypeError):
            workspace = None
        if workspace is not None and find_model_yaml(workspace) is not None:
            return Target(
                kind="workspace",
                path=workspace,
                landing=f"/runs/{run_dir.name}",
                results_file=results_file,
                run_id=run_dir.name,
                capabilities=_capabilities(editable=True),
            )

    return Target(
        kind="results",
        path=results_file,
        landing="/results",
        results_file=results_file,
        capabilities=_capabilities(editable=False),
    )


def _capabilities(*, editable: bool) -> dict:
    return {"edit": editable, "run": editable, "runs": editable, "snapshot": editable}
