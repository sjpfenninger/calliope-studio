"""Reading a validation outcome back out of a worker run.

Validation comes in tiers of increasing cost, none of which needs a solver:

- **syntax** — can every YAML file be parsed? In-process, milliseconds. That tier
  is a statement about files rather than about running anything, so it lives in
  `calligraph.modeldef.validate`.
- **definition** — does `calliope.read_yaml` accept it? This runs the full
  pydantic validation of config and model definition, resolves scenarios,
  overrides and templates, and builds the xarray dataset, so it catches missing
  or inconsistent data and broken data tables.
- **build** — additionally `model.build()`, which validates the math strings and
  assembles the optimisation problem.

The last two import Calliope and can take seconds to minutes, so they run in the
same worker subprocess machinery as a real run — which is why turning what that
worker reported into a problem list belongs here.
"""


def errors_from_outcome(outcome: dict, model_file: str) -> dict:
    """Turns a worker outcome into the frontend's problem-list shape.

    Calliope aggregates its errors into one formatted multi-line string rather
    than a structured list, and does not report line numbers, so each message
    becomes a single file-level problem. Splitting the aggregate into its bullet
    points is the most we can honestly recover.
    """
    if outcome.get("status") in ("success", "infeasible"):
        return {"errors": []}

    message = outcome.get("error") or "Validation failed."
    lines = [line.strip(" *-\t") for line in message.splitlines()]
    parts = [line for line in lines if line] or [message]

    return {
        "errors": [
            {
                "file": model_file,
                "line": None,
                "column": None,
                "message": part,
                "severity": "error",
            }
            for part in parts
        ]
    }
