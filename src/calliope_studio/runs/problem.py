"""How large the optimisation problem is, counted off Calliope's own backend.

Nothing else in the project answers this. A run reports a stage, a solver, an
objective and a duration, and none of those is a size. The solver's own log is
the only place one appears today: CBC writes "Presolve 3466 (-2901) rows, 4224
(-842) columns" partway down several hundred lines of DEBUG output, once the
solve is already under way, and only because it happens to be a solver that says
so. That is not an answer to "how big is this model" — it is buried, it is late,
it is per-solver, and it is a different number (see below).

`model.backend.variables` and `.constraints` are xarray Datasets of backend
objects, NaN wherever a component's `where` did not match, and all three backends
populate them through the same `_add_to_dataset` in Calliope's
`BackendModelGenerator`. Counting the non-null entries is therefore exact and
backend-agnostic, and no solver-specific route exists to prefer over it: the
Pyomo kernel block Calliope builds has no `nvariables()`, and Gurobi's counters
would answer for Gurobi alone.

**These are the counts as Calliope built them, before the solver's presolve.**
On `national_scale` that is 5,066 variables and 6,367 constraints against the
4,224 columns and 3,466 rows CBC goes on to solve — the differences are exactly
the `(-842)` and `(-2901)` in its own presolve line, which is a useful check on
the counting and a warning about the labelling. Anything displaying these must
say which they are: a pre-presolve count presented as what the solver saw would
be a wrong number stated confidently.
"""

from typing import Any

#: The component groups worth counting, in the order they are reported.
#:
#: `piecewise_constraints` counts *blocks* rather than rows — one element of that
#: array is a whole piecewise construction — which is why it is reported apart
#: from `constraints` rather than added to it.
GROUPS = ("variables", "constraints", "piecewise_constraints", "global_expressions")

#: Groups broken down per component as well as totalled. Only these two: nobody
#: sizes a model by its global expressions, and the breakdown is there to answer
#: "which part of my math is this big", which is a question about the two groups
#: the solver actually receives.
DETAILED = ("variables", "constraints")


def summarise(model: Any) -> dict:
    """Component counts for a built model, or `{}` if they cannot be had.

    Guarded throughout rather than allowed to raise. This is a convenience on top
    of a run, and a Calliope release that has moved one of these accessors must
    not turn a successful solve into a failed run — the same rule
    `worker._record_diagnostics` states for timings and the objective.

    Args:
        model: A `calliope.Model` on which `build()` has been called. An
            unbuilt one has no backend and yields `{}`.

    Returns:
        Totals per group, `integer_variables`, and a `components` mapping of
        `{group: {component name: count}}` for `DETAILED`, each sorted largest
        first — which is the order anybody reading it wants, and saves every
        consumer sorting it again.
    """
    backend = getattr(model, "backend", None)
    if backend is None:
        return {}

    counted = {group: _count(getattr(backend, group, None)) for group in GROUPS}
    if not any(counted.values()):
        return {}

    summary: dict = {group: sum(counted[group].values()) for group in GROUPS}
    summary["integer_variables"] = _integer_variables(model, counted["variables"])
    summary["components"] = {
        group: dict(sorted(counted[group].items(), key=lambda item: -item[1]))
        for group in DETAILED
    }
    return summary


def _count(dataset: Any) -> dict[str, int]:
    """How many entries of each component array the backend actually built.

    A component counting zero is dropped: its `where` matched nothing in this
    model, so it is not part of the problem at all. That is the same state
    `mathdoc._component` labels `unmatched`, and listing it here as a nought
    would pad the breakdown with rows that say nothing.
    """
    if dataset is None:
        return {}

    counted: dict[str, int] = {}
    for name, array in getattr(dataset, "data_vars", {}).items():
        try:
            total = int(array.notnull().sum())
        except (AttributeError, TypeError, ValueError):
            continue
        if total:
            counted[str(name)] = total
    return counted


def _integer_variables(model: Any, counted: dict[str, int]) -> int:
    """How many of the built variables are integer or binary.

    Read off the math definitions rather than from
    `backend.has_integer_or_binary_variables`, which walks every variable object
    on all three backends — 0.12 s on `national_scale`, with Pyomo assembling a
    whole `build_model_size_report` on the way — to return a bool. The domain is
    declared per variable component, so combining it with the counts above gives
    the count instead of the flag, for nothing.
    """
    domains = _variable_domains(model)
    return sum(
        count for name, count in counted.items() if domains.get(name, "real") != "real"
    )


def _variable_domains(model: Any) -> dict[str, str]:
    """Each variable component's declared domain, from the built math."""
    try:
        dumped = model.math.build.variables.model_dump()
    except AttributeError:
        return {}
    if not isinstance(dumped, dict):
        return {}
    return {
        str(name): str(spec.get("domain", "real"))
        for name, spec in dumped.items()
        if isinstance(spec, dict)
    }
