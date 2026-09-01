"""Builds the netCDF layouts Calliope has written, from scratch.

The results reader recognises a `.nc` by its *structure*, and these are that
structure stated explicitly: a 0.7.0.dev7-and-later file with `inputs`,
`results` and `attrs` groups, a 0.7.0.dev6-and-earlier file that is one flat
dataset with an `is_result` flag per variable, and a 0.7.0 file — the grouped
layout again, with the traits the release changed: `active` in place of
`definition_matrix` (and without its carriers dimension), no math metadata
duplicated onto array attrs, a `postprocessed` math block, and the `__active`
scratch array Calliope leaks into the saved inputs.

**Why synthesise rather than commit a real file.** The sample `.nc` files this
repository has are gitignored, and `pixi run solve-examples` writes only two of
them — neither in the older layout, because the installed Calliope cannot
produce one. So every layout test skipped in CI, and the regression they exist
for was protected on one developer's machine and nowhere else.

Subsetting a real file does not fix that: its `math` attribute alone is 151 kB,
netCDF does not compress attributes, and HDF5 per-variable overhead dominates,
so a derived fixture lands at 390–500 kB however small the arrays are made.
These are 14 kB and 11 kB.

**The risk this carries, and what answers it.** A synthesised file could drift
from what Calliope actually writes and give false confidence. So
`test_results_layouts.py` keeps its cases against the real samples, skipping
when absent, *and* asserts that these fixtures are structurally equivalent to a
real file wherever one is present — which is every machine that has them.
"""

import io

import numpy as np
import xarray as xr
from ruamel.yaml import YAML

#: Small enough to be cheap, plural enough that a bug in dimension handling has
#: somewhere to show itself.
NODES = ["region1", "region2"]
TECHS = ["ccgt", "demand_power"]
TIMESTEPS = np.array(["2005-01-01T00:00", "2005-01-01T01:00"], dtype="datetime64[ns]")

#: What `results/catalog.py::units_from_math` reads, in the shape Calliope
#: stores it: `math.build.<block>.<name>.unit`.
MATH = {
    "build": {
        "parameters": {"flow_cap_max": {"unit": "power", "title": "Max flow cap"}},
        "variables": {"flow_cap": {"unit": "power"}, "flow_out": {"unit": "energy"}},
        "global_expressions": {"cost": {"unit": "cost"}},
    }
}


def _yaml(value) -> str:
    """A dict as Calliope stores it in a netCDF attribute: a YAML string."""
    buffer = io.StringIO()
    YAML(typ="safe").dump(value, buffer)
    return buffer.getvalue()


def _inputs() -> xr.Dataset:
    dataset = xr.Dataset(
        {
            "flow_cap_max": (
                ("nodes", "techs"),
                np.array([[10.0, 20.0], [30.0, 40.0]]),
            ),
            "color": ("techs", np.array(["#112233", "#445566"], dtype=object)),
        },
        coords={"nodes": NODES, "techs": TECHS},
    )
    # `unit` on the array as well as in the math: the catalogue prefers the
    # array's own, and the two sources have to be distinguishable.
    dataset.flow_cap_max.attrs = {"unit": "power", "title": "Maximum flow capacity"}
    return dataset


def _results() -> xr.Dataset:
    return xr.Dataset(
        {
            "flow_cap": (("nodes", "techs"), np.array([[1.0, 2.0], [3.0, 4.0]])),
            "flow_out": (("nodes", "techs", "timesteps"), np.ones((2, 2, 2))),
        },
        coords={"nodes": NODES, "techs": TECHS, "timesteps": TIMESTEPS},
    )


def write_grouped(path) -> "object":
    """A 0.7.0.dev7-and-later file: `inputs`, `results` and `attrs` groups.

    The `attrs` group holds **no variables at all** — `config`, `definition`,
    `runtime` and the whole applied `math` are netCDF *attributes* on it,
    serialised as YAML and listed in `serialised_dicts` so a reader knows to
    parse them back.
    """
    attrs = xr.Dataset()
    attrs.attrs = {
        "config": _yaml(
            {"init": {"name": "layout fixture"}, "solve": {"solver": "cbc"}}
        ),
        "definition": _yaml(
            {
                "techs": {
                    "ccgt": {"base_tech": "supply"},
                    "region1_to_region2": {
                        "base_tech": "transmission",
                        "link_from": "region1",
                        "link_to": "region2",
                    },
                }
            }
        ),
        "runtime": _yaml(
            {
                "name": "layout fixture",
                "calliope_version_initialised": "0.7.0.dev7",
                "termination_condition": "optimal",
            }
        ),
        "math": _yaml(MATH),
        "serialised_dicts": ["config", "definition", "runtime", "math"],
    }

    _inputs().to_netcdf(path, group="inputs", mode="w")
    _results().to_netcdf(path, group="results", mode="a")
    attrs.to_netcdf(path, group="attrs", mode="a")
    return path


def write_070(path) -> "object":
    """A 0.7.0 file: the grouped layout, with what the release changed.

    - `active` over (nodes, techs) replaces `definition_matrix` and its
      carriers dimension — what `results/geo.py` masks links by.
    - `__active`, the scratch array `ModelDataCleaner._drop_undefined` builds,
      leaks into the saved inputs; the reader must drop it or it becomes a
      chartable variable.
    - **No unit/title attrs on any array.** 0.7.0 stopped duplicating math
      metadata onto arrays, so the file's own stored math is the only source.
    - The math carries a `postprocessed` block, whose units the catalogue must
      read like any other expression's.
    - `link_from`/`link_to` persist as input arrays.
    """
    inputs = xr.Dataset(
        {
            "flow_cap_max": (
                ("nodes", "techs"),
                np.array([[10.0, 20.0], [30.0, 40.0]]),
            ),
            "color": ("techs", np.array(["#112233", "#445566"], dtype=object)),
            "active": (("nodes", "techs"), np.ones((2, 2), dtype=bool)),
            "__active": (("nodes", "techs"), np.ones((2, 2))),
            "base_tech": ("techs", np.array(["supply", "transmission"], dtype=object)),
            "link_from": ("techs", np.array([None, "region1"], dtype=object)),
            "link_to": ("techs", np.array([None, "region2"], dtype=object)),
            "longitude": ("nodes", np.array([4.0, 5.0])),
            "latitude": ("nodes", np.array([50.0, 51.0])),
        },
        coords={"nodes": NODES, "techs": ["ccgt", "region1_to_region2"]},
    )

    math = {
        "build": {
            **MATH["build"],
            "postprocessed": {"capacity_factor": {"unit": "unitless"}},
        }
    }
    attrs = xr.Dataset()
    attrs.attrs = {
        "config": _yaml(
            {"init": {"name": "layout fixture"}, "solve": {"solver": "cbc"}}
        ),
        "definition": _yaml({"techs": {"ccgt": {"base_tech": "supply"}}}),
        "runtime": _yaml(
            {
                "name": "layout fixture",
                "calliope_version_initialised": "0.7.0",
                "termination_condition": "optimal",
            }
        ),
        "math": _yaml(math),
        "serialised_dicts": ["config", "definition", "runtime", "math"],
    }

    results = xr.Dataset(
        {
            "flow_cap": (("nodes", "techs"), np.array([[1.0, 2.0], [3.0, 4.0]])),
            "flow_out": (("nodes", "techs", "timesteps"), np.ones((2, 2, 2))),
            "capacity_factor": (("nodes", "techs"), np.full((2, 2), 0.5)),
        },
        coords={
            "nodes": NODES,
            "techs": ["ccgt", "region1_to_region2"],
            "timesteps": TIMESTEPS,
        },
    )

    inputs.to_netcdf(path, group="inputs", mode="w")
    results.to_netcdf(path, group="results", mode="a")
    attrs.to_netcdf(path, group="attrs", mode="a")
    return path


def write_flat(path) -> "object":
    """A 0.7.0.dev6-and-earlier file: one dataset, split on `is_result`.

    Deliberately carries **no definition**. dev6 recorded `def_path` — a path to
    the files — rather than the `_model_def_dict` its predecessors stored, so a
    reader that assumed one would be wrong about the version this represents.
    The metadata is also differently spelled: `applied_math`, and the version as
    a loose root attribute rather than inside `runtime`.
    """
    inputs, results = _inputs(), _results()
    dataset = xr.merge([inputs, results])
    for name in inputs.data_vars:
        dataset[name].attrs = {**inputs[name].attrs, "is_result": 0}
    for name in results.data_vars:
        dataset[name].attrs = {"is_result": 1}

    dataset.attrs = {
        "name": "layout fixture",
        "config": _yaml({"init": {"name": "layout fixture"}}),
        "applied_math": _yaml(MATH),
        "def_path": "/somewhere/model.yaml",
        "calliope_version_initialised": "0.7.0.dev6",
        "termination_condition": "optimal",
        "serialised_dicts": ["config", "applied_math"],
    }
    dataset.to_netcdf(path, mode="w")
    return path
