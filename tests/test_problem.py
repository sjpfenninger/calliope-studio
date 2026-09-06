"""Counting the optimisation problem, against models that really build.

This is a number shown to a modeller deciding whether to cut timesteps or nodes,
so being wrong about it is worse than not having it. The counts come off
Calliope's backend datasets, where an entry is NaN wherever a component's `where`
did not match — so the failure mode that matters is counting the array rather
than its non-null entries, which inflates every figure by the sparsity of the
model and looks entirely plausible. `test_counts_exclude_what_where_rejected` is
the one that would notice.

Both example models are built here rather than mocked. The point of the module
is agreement with Calliope, and a stub of `model.backend` would only assert that
the test author and the implementation share an assumption.
"""

import pytest

from calliope_studio.runs import problem


@pytest.fixture(scope="module")
def built():
    """A built `national_scale` — an LP, so no integer variables anywhere."""
    from calliope.examples import national_scale

    model = national_scale()
    model.build()
    return model


@pytest.fixture(scope="module")
def built_milp():
    """A built `urban_scale` under its `milp` scenario.

    The only fixture here with integer variables in it, and so the only one that
    exercises the domain lookup at all.
    """
    from calliope.examples import urban_scale

    model = urban_scale(scenario="milp")
    model.build()
    return model


def test_reports_both_halves_of_the_problem(built):
    """A model that built has variables and constraints; zero would be a miscount.

    Global expressions are reported apart from constraints because the solver
    never sees them, and piecewise constraints apart again because one entry
    there is a whole construction rather than a row.
    """
    summary = problem.summarise(built)

    assert summary["variables"] > 0
    assert summary["constraints"] > 0
    assert summary["global_expressions"] > 0
    assert summary["piecewise_constraints"] == 0


def test_components_sum_to_their_totals(built):
    """The breakdown and the headline must be the same count, read two ways.

    They are shown a click apart — the totals in the run tab's header, the
    breakdown in its config pane — so a component silently dropped from one and
    not the other is a discrepancy the user is the first to notice.
    """
    summary = problem.summarise(built)

    for group, components in summary["components"].items():
        assert sum(components.values()) == summary[group]


def test_components_are_largest_first(built):
    """Sorted here so that every consumer reads it in the order it is wanted.

    The breakdown exists to answer "which part of my math is this big", which is
    a question answered by the top of the list.
    """
    summary = problem.summarise(built)

    for components in summary["components"].values():
        counts = list(components.values())
        assert counts == sorted(counts, reverse=True)


def test_components_never_carry_a_nought(built):
    """A component whose `where` matched nothing is not part of the problem.

    Calliope still holds an all-NaN array for it, so it would otherwise appear in
    the breakdown as a row saying nothing — the same state `mathdoc` labels
    `unmatched` and declines to render.
    """
    summary = problem.summarise(built)

    for components in summary["components"].values():
        assert all(count > 0 for count in components.values())


def test_counts_exclude_what_where_rejected(built):
    """Non-null entries, not array elements.

    Every component array is dimensioned over the full product of its `foreach`,
    and most of that product is NaN — a technology exists at a handful of the
    nodes, not all of them. Counting `size` instead would inflate the figure by
    the model's sparsity, which on `national_scale` is more than an order of
    magnitude, and would still look like a believable number.
    """
    summary = problem.summarise(built)
    dense = sum(array.size for array in built.backend.constraints.values())

    assert summary["constraints"] < dense


def test_an_lp_reports_no_integer_variables(built):
    """`national_scale` declares every variable `domain: real`."""
    assert problem.summarise(built)["integer_variables"] == 0


def test_a_milp_counts_its_integer_variables(built_milp):
    """The domain lookup, which is the one part not read off the backend.

    Taken from `model.math.build` rather than from
    `backend.has_integer_or_binary_variables`, which walks every variable object
    on all three backends to return a bool. If the math schema stops declaring
    `domain`, every MILP silently reports itself as an LP.
    """
    summary = problem.summarise(built_milp)

    assert 0 < summary["integer_variables"] < summary["variables"]


def test_an_unbuilt_model_yields_nothing(built):
    """`build()` is what creates the backend; before it there is nothing to count.

    Empty rather than an exception: `init_only` and `math_only` runs pass through
    the same worker and must not fail for lacking a number nobody asked them for.
    """
    from calliope.examples import national_scale

    assert problem.summarise(national_scale()) == {}


def test_a_model_shaped_differently_yields_nothing():
    """A Calliope release that moves these accessors must not fail a run.

    The whole feature is a convenience on top of a solve that has already
    happened, so every lookup degrades to "no answer" rather than raising past
    the worker and turning a finished run into a failed one.
    """
    assert problem.summarise(object()) == {}
