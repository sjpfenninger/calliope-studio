"""Which solvers a Calliope run can actually reach.

The editor used to offer a list written into the frontend — six names, of which
one was installed, and two (`highs`, `cpsat`) are not Pyomo solver names at all.
Calliope's own schema is no help here: `config.solve.solver` is a free string
whose description says "any solvers that have Pyomo interfaces can be used", so
there is no enum to read and the only honest answer comes from asking Pyomo.

Answering it is *suggestion*, never restriction. The field stays free text,
because a model is often written on one machine and solved on another.

`probe_solvers` is deliberately self-contained — no module state, no arguments,
one local import — so that the same source can be handed to another interpreter
as `python -c` once a run can be pointed at one. Nothing does that yet; the
shape is what keeps the seam from needing an incompatible change.
"""

import sys

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

#: Probe results, keyed by the interpreter that produced them.
#:
#: Keyed rather than a single slot, because a run becomes selectable per
#: workspace and the moment two interpreters are in play one slot answers for
#: whichever asked last.
_probed: dict[str, list[str]] = {}


def probe_solvers() -> list[str]:
    """The candidates Pyomo reports as usable, in `SOLVER_CANDIDATES` order.

    Costs nothing measurable in the server: importing Calliope has already
    pulled Pyomo in.
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


def available_solvers(interpreter: str | None = None) -> list[str]:
    """The solvers `interpreter` can reach, defaulting to this process's own.

    Cached for the process lifetime, as the schemas are: a solver appearing on
    PATH mid-session is not a case worth re-probing for, and restarting is what
    picks up any other change to the environment.

    A foreign interpreter raises rather than quietly reporting the host's
    solvers. Substituting one environment's answer for another's is the class of
    bug this codebase refuses everywhere else it comes up — it produces a list
    that looks right and is not.

    Raises:
        NotImplementedError: If `interpreter` is not the one running this
            process. Probing another is what the environment registry adds.
    """
    target = interpreter or sys.executable
    if target != sys.executable:
        raise NotImplementedError(
            f"Cannot report solvers for {target}: only the interpreter running "
            "the server can be probed."
        )
    if target not in _probed:
        _probed[target] = probe_solvers()
    return _probed[target]


def forget_probes() -> None:
    """Drops every cached probe.

    For tests. Nothing in the application re-probes: see `available_solvers`.
    """
    _probed.clear()
