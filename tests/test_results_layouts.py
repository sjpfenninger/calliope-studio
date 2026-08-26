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
