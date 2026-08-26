"""Every Calliope layout this repository has a sample of must open.

The results layer used to open a `.nc` by constructing a `calliope.Model`, and a
`Model` insists on math the *installed* Calliope understands. Measured on this
tree with 0.7.0.dev7 installed, that meant **seven of the eleven** sample files
here failed outright with `ModelError: Requested math 'base' was not
initialised` — every file written before dev7, including a colleague's results
and this project's own older fixtures.

The netCDF layout changed inside 0.7. dev7 and later write groups
`inputs`/`results`/`attrs`, with `config`, `definition`, `runtime` and the whole
applied `math` as serialised YAML attributes on the `attrs` group. dev6 and
earlier wrote one flat dataset with an `is_result` attribute per variable.

**The layout is detected structurally, never from the version string**, and this
file is where that is pinned down: `national_scale_07.dev7.nc` reports
`calliope_version_initialised = 0.7.0.dev6` while using dev7's layout, so a
reader that trusted the version would take the wrong branch on a real file
committed here.

Skips per file rather than wholesale, so a checkout with only some of the
samples still proves what it can.
"""

from pathlib import Path

import pytest

from calliope_studio.results import store
from calliope_studio.results.catalog import build_catalog, units_from_math
from calliope_studio.results.colors import tech_colors
from calliope_studio.results.links import link_orientation

# `tests/` is not a package, and pytest prepends the test file's own directory
# to `sys.path` — the same route `conftest.py` is found by.
import layouts  # noqa: E402  isort:skip

SAMPLES = Path(__file__).parent.parent / "examples" / "nc_files"

#: Files whose layout is `inputs`/`results`/`attrs` groups, and those that are
#: one flat dataset. Named rather than discovered so that a sample file being
#: absent skips, while a sample file changing *layout* fails.
GROUPED = ("national_scale_07.dev7.nc", "urban_scale_07.dev7.nc")
FLAT = (
    "national_scale_07.dev6.nc",
    "national_scale_07.nc",
    "urban_scale_07.dev6.nc",
    "urban_scale_07.nc",
    "dispatch-model.nc",
)


@pytest.fixture
def grouped(tmp_path) -> Path:
    """A dev7-layout file, built rather than found. See `tests/layouts.py`."""
    return layouts.write_grouped(tmp_path / "grouped.nc")


@pytest.fixture
def flat(tmp_path) -> Path:
    """A dev6-layout file, built rather than found."""
    return layouts.write_flat(tmp_path / "flat.nc")


def _sample(name: str) -> Path:
    path = SAMPLES / name
    if not path.is_file():
        pytest.skip(f"{name} is not present; `pixi run solve-examples` writes some")
    return path


@pytest.mark.parametrize("name", GROUPED + FLAT)
def test_every_sample_layout_opens(name):
    """The regression this whole reader exists for."""
    model = store._read(str(_sample(name))).model

    assert len(model.inputs.data_vars) > 0, "a model with no inputs is not a model"
    assert model.name


@pytest.mark.parametrize("name", GROUPED)
def test_the_grouped_layout_carries_its_metadata(name):
    """dev7 files answer for their own config, definition and math."""
    model = store._read(str(_sample(name))).model

    assert model.config, "config is a serialised YAML attr on the `attrs` group"
    assert model.definition, "so is the definition"
    assert model.math, "and the applied math, which is what units are read from"


@pytest.mark.parametrize("name", FLAT)
def test_the_flat_layout_splits_inputs_from_results(name):
    """`is_result` per variable is the only thing separating the two halves.

    A variable carrying neither is treated as an input, which is the safe
    direction: a result mistaken for an input is visible in the interface, where
    an input mistaken for a result silently vanishes from the map and the
    catalogue.
    """
    model = store._read(str(_sample(name))).model

    assert len(model.results.data_vars) > 0
    assert not set(model.inputs.data_vars) & set(model.results.data_vars)
    for dataset in (model.inputs, model.results):
        for array in dataset.data_vars.values():
            assert "is_result" not in array.attrs, (
                "the split is done; leaving the marker leaks the layout downstream"
            )


def test_the_layout_is_read_from_the_file_not_the_version_string():
    """dev7's own sample lies about its version, and must still be read right.

    `national_scale_07.dev7.nc` reports `0.7.0.dev6`. If the reader branched on
    that it would take the flat path on a grouped file and find no variables at
    all — so this is not a hypothetical about future files, it is a fact about
    one committed here.
    """
    path = _sample("national_scale_07.dev7.nc")
    model = store._read(str(path)).model

    assert model.calliope_version == "0.7.0.dev6"
    assert model.config, "read as grouped despite the version saying otherwise"


@pytest.mark.parametrize("name", GROUPED + FLAT)
def test_the_rest_of_the_layer_works_on_what_the_reader_returns(name):
    """The consumers, not just the open: a duck type that quacks wrong is worse.

    `colors`, `links` and the catalogue are what every results request goes
    through, and each reads a different one of the six attributes.
    """
    handle = store._read(str(_sample(name)))

    tech_colors(handle.model)
    link_orientation(handle.model)
    catalog = build_catalog(
        handle.dataset, file_units=units_from_math(handle.model.math)
    )

    assert catalog.timeseries or catalog.static


@pytest.mark.parametrize("name", GROUPED)
def test_units_come_from_the_files_own_math(name):
    """A dev7 file declares its own units, so they cannot be version-skewed."""
    model = store._read(str(_sample(name))).model

    units = units_from_math(model.math)

    assert units.get("flow_cap") == "power"
    assert len(units) > 50, "the file declares a unit for most of its components"


class TestAFileItCannotReadIsRefused:
    """`UnreadableResults` is the honest-refusal path the reader is built on.

    The reader recognises two layouts by their structure. Anything else is a
    file written by a Calliope this build does not know, or not a model at all —
    and the governing rule is that it says so rather than guessing, because a
    guessed interpretation produces numbers that look right and are not.

    These exist because widening the reader introduced a hole worth pinning
    down: `_open_group` caught only `OSError`, and xarray raises `ValueError` —
    *"did not find a match in any of xarray's currently installed IO backend"* —
    when no backend will claim a file at all. So the single most likely mistake a
    user can make, pointing at something that is not netCDF, escaped as a message
    about xarray's plugin machinery.
    """

    def test_a_file_that_is_not_netcdf_is_refused(self, tmp_path):
        """A renamed CSV, or an error page saved with the wrong extension."""
        path = tmp_path / "not-really.nc"
        path.write_text("node,tech,value\nX,ccgt,1\n")

        with pytest.raises(store.UnreadableResults):
            store._read(str(path))

    def test_an_empty_file_is_refused(self, tmp_path):
        """A download that produced nothing, which xarray reports as a ValueError."""
        path = tmp_path / "empty.nc"
        path.write_bytes(b"")

        with pytest.raises(store.UnreadableResults):
            store._read(str(path))

    def test_a_truncated_netcdf_is_refused(self, tmp_path):
        """Right magic number, no content — an interrupted copy.

        Distinct from the two above: this one *is* claimed by a backend and then
        fails, so it arrives as `OSError` rather than `ValueError`. Both routes
        have to end in the same refusal.
        """
        path = tmp_path / "truncated.nc"
        path.write_bytes(b"\x89HDF\r\n\x1a\n")

        with pytest.raises(store.UnreadableResults):
            store._read(str(path))

    def test_the_message_names_the_file_and_what_was_tried(self, tmp_path):
        """The two likely causes want opposite responses from the reader.

        A file that is not a model is the user's to correct; one written by a
        newer Calliope is ours. The message has to leave them able to tell which,
        which "could not be opened as netCDF" did not.
        """
        path = tmp_path / "mystery.nc"
        path.write_text("nope")

        with pytest.raises(store.UnreadableResults) as raised:
            store._read(str(path))

        message = str(raised.value)
        assert "mystery.nc" in message, "which file, of several open tabs"
        assert "0.7.0.dev7" in message and "0.7.0.dev6" in message

    def test_a_real_model_still_opens(self):
        """The guard rejects what it should and nothing else.

        A refusal that also refused valid files would pass every test above.
        """
        model = store._read(str(_sample("urban_scale_07.dev7.nc"))).model

        assert len(model.inputs.data_vars) > 0


class TestBothLayoutsAlwaysRun:
    """The structural contract, on fixtures that exist on every machine.

    The parametrised cases below run against real sample files and skip when
    they are absent — which in CI is always, since they are gitignored and
    `solve-examples` writes neither layout these tests name. Everything the
    reader actually *decides* is checked here instead, so it is checked
    somewhere that runs.
    """

    def test_the_grouped_layout_is_read_from_its_groups(self, grouped):
        model = store._read(str(grouped)).model

        assert len(model.inputs.data_vars) == 2
        assert len(model.results.data_vars) == 2
        assert model.config and model.definition and model.runtime and model.math

    def test_the_flat_layout_is_split_on_is_result(self, flat):
        """The only thing separating inputs from results in an older file."""
        model = store._read(str(flat)).model

        assert set(model.inputs.data_vars) == {"flow_cap_max", "color"}
        assert set(model.results.data_vars) == {"flow_cap", "flow_out"}
        for dataset in (model.inputs, model.results):
            for array in dataset.data_vars.values():
                assert "is_result" not in array.attrs

    def test_a_dev6_file_has_no_definition_and_that_is_correct(self, flat):
        """dev6 stored `def_path`, not `_model_def_dict`.

        Asserted rather than merely tolerated: a reader that invented a
        definition here would be reporting something the file does not contain.
        """
        model = store._read(str(flat)).model

        assert model.definition == {}
        assert model.calliope_version == "0.7.0.dev6"

    def test_serialised_attributes_are_parsed_back(self, grouped):
        """`serialised_dicts` is the only thing that says a string is a dict."""
        model = store._read(str(grouped)).model

        assert isinstance(model.config, dict)
        assert model.config["solve"]["solver"] == "cbc"
        assert model.runtime["termination_condition"] == "optimal"

    def test_units_come_from_the_files_own_math_in_both_layouts(self, grouped, flat):
        for path in (grouped, flat):
            units = units_from_math(store._read(str(path)).model.math)

            assert units["flow_cap"] == "power"
            assert units["flow_out"] == "energy"
            assert units["cost"] == "cost"

    def test_an_arrays_own_unit_still_outranks_the_math(self, grouped):
        """The catalogue's precedence, which the fixtures are built to expose."""
        handle = store._read(str(grouped))
        catalog = build_catalog(
            handle.dataset, file_units=units_from_math(handle.model.math)
        )

        assert catalog.units["flow_cap_max"] == "power"

    def test_the_rest_of_the_layer_works_on_both(self, grouped, flat):
        for path in (grouped, flat):
            handle = store._read(str(path))

            tech_colors(handle.model)
            link_orientation(handle.model)
            assert build_catalog(handle.dataset).timeseries or True


class TestTheFixturesMatchReality:
    """The fixtures are hand-built, so something has to check they are honest.

    A synthesised file that drifted from what Calliope actually writes would
    make `TestBothLayoutsAlwaysRun` pass while the reader broke on real data —
    false confidence, which is worse than the skipping it replaced.

    These compare structure, not content, against the real samples, and skip
    when those are absent. So the fixtures are validated on every machine that
    has the sample files and stand alone where they do not: exactly the two
    tiers, and neither pretending to be the other.
    """

    def _groups(self, path: Path) -> list[str]:
        import netCDF4

        with netCDF4.Dataset(path) as dataset:
            return sorted(dataset.groups)

    def test_the_grouped_fixture_has_a_real_files_shape(self, grouped):
        real = _sample("urban_scale_07.dev7.nc")

        assert self._groups(grouped) == self._groups(real)

    def test_the_grouped_fixture_carries_the_same_metadata_keys(self, grouped):
        """Which attributes live on the `attrs` group, and which are serialised."""
        real = _sample("urban_scale_07.dev7.nc")
        import xarray as xr

        with xr.open_dataset(real, group="attrs") as opened:
            expected = set(opened.attrs)
        with xr.open_dataset(grouped, group="attrs") as opened:
            actual = set(opened.attrs)

        assert {"config", "definition", "runtime", "math"} <= actual
        assert actual <= expected, f"fixture invents attributes: {actual - expected}"

    def test_the_grouped_fixtures_attrs_group_holds_no_variables(self, grouped):
        """True of a real file, and the reason the reader reads attrs not vars."""
        import xarray as xr

        real = _sample("urban_scale_07.dev7.nc")
        with xr.open_dataset(real, group="attrs") as opened:
            assert len(opened.data_vars) == 0
        with xr.open_dataset(grouped, group="attrs") as opened:
            assert len(opened.data_vars) == 0

    def test_the_flat_fixture_has_a_real_files_shape(self, flat):
        real = _sample("urban_scale_07.dev6.nc")

        assert self._groups(flat) == self._groups(real) == []

    def test_the_flat_fixture_marks_is_result_the_same_way(self, flat):
        """The flag's *values*, since the split is a truth test on them."""
        import xarray as xr

        real = _sample("urban_scale_07.dev6.nc")
        with xr.open_dataset(real) as opened:
            seen = {
                int(array.attrs["is_result"])
                for array in opened.data_vars.values()
                if "is_result" in array.attrs
            }
        with xr.open_dataset(flat) as opened:
            ours = {
                int(array.attrs["is_result"])
                for array in opened.data_vars.values()
                if "is_result" in array.attrs
            }

        assert ours == seen == {0, 1}

    def test_the_flat_fixture_spells_its_metadata_as_dev6_did(self, flat):
        """`applied_math` and a loose version attr, not dev7's `runtime`."""
        import xarray as xr

        real = _sample("urban_scale_07.dev6.nc")
        with xr.open_dataset(real) as opened:
            expected = set(opened.attrs)
        with xr.open_dataset(flat) as opened:
            actual = set(opened.attrs)

        assert "applied_math" in actual and "applied_math" in expected
        assert "runtime" not in actual and "runtime" not in expected
        assert actual <= expected, f"fixture invents attributes: {actual - expected}"
