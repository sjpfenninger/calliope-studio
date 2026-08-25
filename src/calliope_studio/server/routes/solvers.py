"""What the machine running the server can solve with.

Separate from `schema.py` because it is not a schema: Calliope says what a model
may contain, and this says what this installation can do about it.
"""

from fastapi import APIRouter

from calliope_studio.runs.solvers import available_solvers

router = APIRouter(tags=["solvers"])


@router.get("/solvers/")
def get_solvers() -> dict:
    """Solver names Pyomo reports as usable here.

    Suggestions for `config.solve.solver`, which stays free text — Calliope
    accepts any name with a Pyomo interface, and a model is often written
    somewhere other than where it will be solved.
    """
    return {"solvers": available_solvers()}
