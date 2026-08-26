"""The solver list is what Pyomo answered, not what the editor assumed.

Offering a solver that is not installed is a promise the app cannot keep: the
failure arrives minutes later, as a Pyomo "solver not found" line buried in a
run log. The frontend used to name six solvers of which one worked here, so what
these tests protect is that every name reaching the field survived a real
availability check, and that a candidate whose Pyomo constructor *raises* —
several want a Python package that is not installed — is dropped rather than
taking the whole probe down with it.
"""

import sys

import pytest
from fastapi.testclient import TestClient

from calliope_studio.runs import solvers


@pytest.fixture
def ws(client: TestClient) -> str:
    return client.workspace_id


def test_probes_rather_than_asserts():
    """Every reported name is a candidate Pyomo confirmed it can construct."""
    available = solvers.available_solvers()

    assert set(available) <= set(solvers.SOLVER_CANDIDATES)
    # The default environment ships coin-or-cbc, which is also Calliope's own
    # default for `config.solve.solver`, so an empty answer here means the probe
    # is broken rather than that the machine is bare.
    assert "cbc" in available


def test_a_candidate_that_cannot_be_constructed_is_dropped(monkeypatch):
    """A missing Python package must cost one name, not the whole list."""

    from pyomo.opt import SolverFactory as real_factory

    def explode(name):
        if name == "cbc":
            raise ModuleNotFoundError("No module named 'nope'")
        return real_factory(name)

    solvers.forget_probes()
    monkeypatch.setattr("pyomo.opt.SolverFactory", explode)
    try:
        assert "cbc" not in solvers.available_solvers()
    finally:
        solvers.forget_probes()


def test_endpoint_serves_the_probe(client: TestClient, ws: str):
    """The config editor's suggestions come from the model's own route.

    Under `/versions/{id}/` rather than at the root because the answer depends on
    where the model's runs happen, and today's global answer is a coincidence of
    there being one interpreter — not a property of the question.
    """
    response = client.get(f"/api/versions/{ws}/solvers/")

    assert response.status_code == 200
    assert response.json() == {"solvers": solvers.available_solvers()}


def test_a_foreign_interpreter_is_refused_rather_than_guessed_at():
    """Reporting the host's solvers for another environment is a wrong answer.

    The registry that makes one selectable is not built yet. Until it is, the
    only honest reply about another interpreter is that we cannot say — the same
    rule this codebase applies to substituting one Calliope for another.
    """
    with pytest.raises(NotImplementedError):
        solvers.available_solvers("/some/other/python")


def test_the_probe_cache_is_keyed_by_interpreter():
    """A single-slot cache would answer for whichever environment asked last."""
    solvers.forget_probes()
    try:
        solvers.available_solvers()
        assert list(solvers._probed) == [sys.executable]
    finally:
        solvers.forget_probes()
