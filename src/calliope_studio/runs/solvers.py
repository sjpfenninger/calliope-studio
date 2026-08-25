"""Which solvers this machine can actually run.

The editor used to offer a list written into the frontend — six names, of which
one was installed, and two (`highs`, `cpsat`) are not Pyomo solver names at all.
Calliope's own schema is no help here: `config.solve.solver` is a free string
whose description says "any solvers that have Pyomo interfaces can be used", so
there is no enum to read and the only honest answer comes from asking Pyomo.

Answering it is *suggestion*, never restriction. The field stays free text,
because a model is often written on one machine and solved on another.
"""

from functools import lru_cache

#: The names worth asking about — LP/MILP solvers a Calliope model would name.
#:
#: A list of what to *ask*, not of what is valid: every answer comes from Pyomo.
#: Named rather than discovered because Pyomo exposes no public enumeration —
#: `SolverFactory` offers only `register`/`unregister`/`get_class`/`doc`, and its
#: registry is a private attribute.
SOLVER_CANDIDATES = (
    "cbc",
    "glpk",
    "highs",
    "appsi_highs",
    "gurobi",
    "gurobi_direct",
    "gurobi_persistent",
    "cplex",
    "cplex_direct",
    "cplex_persistent",
    "scip",
    "xpress",
    "mosek",
)


@lru_cache(maxsize=1)
def available_solvers() -> list[str]:
    """The candidates Pyomo reports as usable, in `SOLVER_CANDIDATES` order.

    Cached for the process lifetime, as the schemas are: a solver appearing on
    PATH mid-session is not a case worth re-probing for, and restarting is what
    picks up any other change to the environment.

    Costs nothing measurable — importing Calliope has already pulled Pyomo in.
    """
    from pyomo.opt import SolverFactory

    available = []
    for name in SOLVER_CANDIDATES:
        # Per candidate, because construction itself raises for several of them:
        # `gurobi_direct`, `cplex_direct` and `xpress` want a Python package that
        # is not installed, and an ASL-backed name wants an executable.
        try:
            solver = SolverFactory(name)
            if solver is not None and solver.available(exception_flag=False):
                available.append(name)
        except Exception:
            continue
    return available
