"""The solver list is what Pyomo answered, not what the editor assumed.

Offering a solver that is not installed is a promise the app cannot keep: the
failure arrives minutes later, as a Pyomo "solver not found" line buried in a
run log. The frontend used to name six solvers of which one worked here, so what
these tests protect is that every name reaching the field survived a real
availability check, and that a candidate whose Pyomo constructor *raises* —
several want a Python package that is not installed — is dropped rather than
taking the whole probe down with it.
"""

from fastapi.testclient import TestClient

from calliope_studio.runs import solvers


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

    solvers.available_solvers.cache_clear()
    monkeypatch.setattr("pyomo.opt.SolverFactory", explode)
    try:
        assert "cbc" not in solvers.available_solvers()
    finally:
        solvers.available_solvers.cache_clear()


def test_endpoint_serves_the_probe(client: TestClient):
    """`GET /api/solvers/` is what the config editor's suggestions come from."""
    response = client.get("/api/solvers/")

    assert response.status_code == 200
    assert response.json() == {"solvers": solvers.available_solvers()}
