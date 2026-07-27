"""Numerical comparison against the frozen v0.2.0 implementation.

The results layer was reimplemented rather than ported, so "it looks right" is
not evidence. v0.2.0 is a working implementation whose output was checked
against real models for months; where the new code is meant to behave
identically, it is compared against it directly.

The old modules are vendored verbatim in `tests/oracle/` and materialised under
a private package name rather than installed, so nothing about their logic
changes and there is no second environment to keep in step. See that directory's
README for provenance; they used to be read out of git, which stopped working
the moment that older history was no longer in the repository.

Skips when the sample `.nc` files are absent, which is the case in CI.
"""

import importlib
import sys
from pathlib import Path

import pandas as pd
import pytest

from calliope_studio.results.catalog import base_tech_members, build_catalog
from calliope_studio.results.colors import tech_colors
from calliope_studio.results.frames import build_table
from calliope_studio.results.query import Query, reduce_array

REPO = Path(__file__).parent.parent

#: Sample models kept in the repository root but not committed. The urban model
#: exercises the geographic path; the national model is the standard fixture.
SAMPLE_MODELS = ["urban_scale_07.dev7.nc", "national_scale_07.dev7.nc"]

#: Where the frozen v0.2.0 sources live, byte-identical to the tag.
ORACLE_DIR = Path(__file__).parent / "oracle"

#: v0.2.0 modules needed for the comparison. `geo` is excluded: the new
#: implementation deliberately dropped the Mercator projection that only Bokeh
#: needed, so there is nothing to compare, and it is the only module that
#: required pyproj.
ORACLE_MODULES = ["__init__", "colors", "variables", "query", "model"]


def _available_models() -> list[str]:
    return [name for name in SAMPLE_MODELS if (REPO / name).is_file()]


pytestmark = pytest.mark.skipif(
    not _available_models(), reason="sample .nc files are not in the repository"
)


#: The name the vendored modules are imported under. They are copied rather than
#: imported in place because `tests/oracle/` is not on the path as a package and
#: their own imports name a package that no longer exists.
ORACLE_PACKAGE = "calliope_studio_v02"

#: The package the vendored sources import from. This is v0.2.0's own layout and
#: is a property of the frozen files, so it does not follow any later rename.
ORACLE_SOURCE_PACKAGE = "calligraph.data"


@pytest.fixture(scope="session")
def oracle(tmp_path_factory):
    """The v0.2.0 data layer, imported under a private name."""
    package_dir = tmp_path_factory.mktemp("oracle") / ORACLE_PACKAGE
    package_dir.mkdir()

    for name in ORACLE_MODULES:
        # A missing file is a real failure, not an environmental one: these are
        # committed, and the comparison is the only numerical evidence there is.
        source = (ORACLE_DIR / f"{name}.py").read_text()
        # Only the package name changes; every line of logic is as tagged.
        (package_dir / f"{name}.py").write_text(
            source.replace(ORACLE_SOURCE_PACKAGE, ORACLE_PACKAGE)
        )

    sys.path.insert(0, str(package_dir.parent))
    try:
        yield importlib.import_module(ORACLE_PACKAGE)
    finally:
        sys.path.remove(str(package_dir.parent))


@pytest.fixture(scope="session", params=_available_models())
def both(request, oracle):
    """The same model, loaded by both implementations."""
    from calliope_studio.results.store import ResultStore

    path = REPO / request.param
    store = ResultStore()
    new = store.get(store.register(path))
    old = oracle.model.ModelData(path)
    return old, new


def to_long(table, variable: str) -> pd.Series:
    """Melts a wide-by-series table back to the shape v0.2.0 returned."""
    import json

    frame = table.to_pandas()
    index_name = table.schema.metadata[b"index"].decode()
    series_dims = json.loads(table.schema.metadata[b"series_dims"].decode())
    frame = frame.set_index(index_name)

    records = []
    for position, name in enumerate(frame.columns, start=1):
        coordinates = json.loads(table.schema.field(position).metadata[b"dims"])
        column = frame[name].rename(variable)
        block = column.to_frame()
        for dimension in series_dims:
            block[dimension] = coordinates[dimension]
        records.append(block.reset_index())

    if not records:
        return pd.Series(dtype="float64", name=variable)

    melted = pd.concat(records, ignore_index=True)
    return (
        melted.set_index([index_name, *series_dims])[variable]
        .sort_index()
        .astype("float64")
    )


def assert_same_values(old: pd.Series, new: pd.Series, context: str) -> None:
    """Compares two series on the keys they share, ignoring level ordering."""
    old = old.dropna().sort_index()
    new = new.dropna().sort_index()
    old.index = old.index.reorder_levels(sorted(old.index.names))
    new.index = new.index.reorder_levels(sorted(new.index.names))
    old, new = old.sort_index(), new.sort_index()

    assert set(old.index) == set(new.index), f"different keys for {context}"
    pd.testing.assert_series_equal(
        old, new.reindex(old.index), check_names=False, rtol=1e-9, atol=1e-12
    )


class TestCatalogMatches:
    def test_categories_are_identical(self, both):
        old, new = both
        old_catalog = old.catalog()
        new_catalog = build_catalog(
            new.dataset, transmission_techs=base_tech_members(new.model, "transmission")
        )
        assert new_catalog.all == old_catalog.all
        assert new_catalog.timeseries == old_catalog.timeseries
        assert new_catalog.static == old_catalog.static
        assert new_catalog.static_nodes == old_catalog.static_nodes
        assert new_catalog.static_links == old_catalog.static_links

    def test_results_only_catalogue_matches(self, both):
        old, new = both
        old_catalog = old.catalog(include_inputs=False)
        new_catalog = build_catalog(
            new.model.results,
            transmission_techs=base_tech_members(new.model, "transmission"),
        )
        assert new_catalog.all == old_catalog.all


class TestColorsMatch:
    def test_every_tech_gets_the_same_colour(self, both):
        old, new = both
        assert tech_colors(new.model) == old.tech_colors


class TestTimeseriesMatch:
    @pytest.mark.parametrize("variable", ["flow*", "flow_out"])
    @pytest.mark.parametrize("resample", [None, "1D", "1ME"])
    @pytest.mark.parametrize("sum_by", ["nodes", "techs"])
    def test_reductions_agree(self, both, variable, resample, sum_by):
        old, new = both
        if variable not in old.catalog().timeseries:
            pytest.skip(f"{variable} not in this model")

        expected = old.timeseries_frame(
            variable, {}, resample=resample, sum_by=sum_by
        ).set_index(
            [
                c
                for c in old.timeseries_frame(
                    variable, {}, resample=resample, sum_by=sum_by
                ).columns
                if c != variable
            ]
        )[
            variable
        ]

        query = Query(
            variable=variable, resample=resample, sum_by=sum_by, drop_zeros=False
        )
        table = build_table(reduce_array(new.dataset, query), query)
        assert_same_values(
            expected, to_long(table, variable), f"{variable} resample={resample}"
        )

    def test_time_range_agrees(self, both):
        old, new = both
        timesteps = new.dataset.timesteps.to_index()
        window = (str(timesteps[0]), str(timesteps[len(timesteps) // 3]))

        frame = old.timeseries_frame("flow*", {}, time_range=window, sum_by="nodes")
        expected = frame.set_index([c for c in frame.columns if c != "flow*"])["flow*"]

        query = Query(
            variable="flow*", time_range=window, sum_by="nodes", drop_zeros=False
        )
        table = build_table(reduce_array(new.dataset, query), query)
        assert_same_values(expected, to_long(table, "flow*"), "flow* time_range")

    def test_selectors_agree(self, both):
        old, new = both
        techs = list(new.dataset.techs.to_index()[:3])

        frame = old.timeseries_frame(
            "flow*", {"techs": techs}, resample="1D", sum_by="nodes"
        )
        expected = frame.set_index([c for c in frame.columns if c != "flow*"])["flow*"]

        query = Query(
            variable="flow*",
            selectors={"techs": techs},
            resample="1D",
            sum_by="nodes",
            drop_zeros=False,
        )
        table = build_table(reduce_array(new.dataset, query), query)
        assert_same_values(expected, to_long(table, "flow*"), "flow* selectors")


class TestStaticMatch:
    @pytest.mark.parametrize("variable", ["flow_cap", "storage_cap"])
    def test_static_values_agree(self, both, variable):
        old, new = both
        if variable not in old.catalog().static:
            pytest.skip(f"{variable} not in this model")

        frame = old.static_frame(variable, {}, drop_zeros=False)
        expected = frame.set_index([c for c in frame.columns if c != variable])[
            variable
        ]

        query = Query(variable=variable, drop_zeros=False)
        table = build_table(reduce_array(new.dataset, query), query)
        assert_same_values(expected, to_long(table, variable), variable)
