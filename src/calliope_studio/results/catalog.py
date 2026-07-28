"""What variables a solved model offers, and how they should be shown.

Reimplemented from the v0.2.0 data layer (`tests/oracle/variables.py`, vendored
verbatim from the tag), with the categories and the `flow*` definition preserved
exactly — those are checked against the old implementation in
`tests/test_oracle.py`.
"""

from dataclasses import dataclass
from typing import Callable, Iterable, Mapping

import xarray as xr


@dataclass(frozen=True)
class SyntheticVariable:
    """A variable computed on demand rather than stored in the model.

    Attributes:
        name: Name under which it is listed and requested.
        requires: Variables that must be present for it to be available.
        compute: Computes it from a dataset containing `requires`.
        title: Human-readable label.
        unit: Its generalised unit, which has to be stated: a computed array
            carries no `attrs` and Calliope's math has never heard of it.
    """

    name: str
    requires: tuple[str, ...]
    compute: Callable[[xr.Dataset], xr.DataArray]
    title: str = ""
    unit: str = ""

    def is_available(self, dataset: xr.Dataset) -> bool:
        return all(name in dataset.data_vars for name in self.requires)


SYNTHETIC_VARIABLES: dict[str, SyntheticVariable] = {
    "flow*": SyntheticVariable(
        name="flow*",
        requires=("flow_out", "flow_in"),
        # Net flow. `fillna(0)` because a technology that only produces has no
        # inflow at all, and NaN would erase the outflow rather than leave it.
        compute=lambda ds: ds.flow_out.fillna(0) - ds.flow_in.fillna(0),
        title="Net flow (out − in)",
        unit="energy",
    )
}


@dataclass(frozen=True)
class VariableCatalog:
    """Categorised variable names for a dataset.

    Attributes:
        all: Every variable.
        timeseries: Those with a `timesteps` dimension, plus synthetic ones.
        static: Those without.
        static_nodes: Static variables carrying node data.
        static_links: Static variables carrying data on a transmission tech.
        dims: Each variable's dimensions, synthetic ones included.
        units: Each variable's generalised unit, where one is known. Only the
            variables that have one appear.
    """

    all: tuple[str, ...]
    timeseries: tuple[str, ...]
    static: tuple[str, ...]
    static_nodes: tuple[str, ...]
    static_links: tuple[str, ...]
    dims: dict[str, tuple[str, ...]]
    units: dict[str, str]

    def as_dict(self) -> dict:
        return {
            "all": list(self.all),
            "timeseries": list(self.timeseries),
            "static": list(self.static),
            "static_nodes": list(self.static_nodes),
            "static_links": list(self.static_links),
            "dims": {name: list(dims) for name, dims in self.dims.items()},
            "units": dict(self.units),
        }


def _has_transmission_data(array: xr.DataArray, transmission_techs: list) -> bool:
    if "techs" not in array.dims:
        return False
    present = [tech for tech in transmission_techs if tech in array.techs.to_index()]
    if not present:
        return False
    return bool(array.sel(techs=present).notnull().any())


def _synthetic_dims(
    dataset: xr.Dataset, variable: SyntheticVariable
) -> tuple[str, ...]:
    """The dimensions a synthetic variable comes out with.

    Taken from the variables it is computed from rather than by computing it: an
    arithmetic combination broadcasts to their union, and `flow*` on a real model
    is the single most expensive array in the dataset to materialise for the sake
    of reading `.dims` off it.
    """
    seen: list[str] = []
    for name in variable.requires:
        for dim in dataset[name].dims:
            if str(dim) not in seen:
                seen.append(str(dim))
    return tuple(seen)


def unit_for(
    dataset: xr.Dataset, variable: str, declared: Mapping[str, str] | None = None
) -> str:
    """A variable's generalised unit — `energy`, `power`, `cost` — or `""`.

    The array's own `attrs` first, because that is the model speaking and it is
    the only thing that can answer for math a user wrote themselves. Calliope's
    declarations second, because the attrs are patchy in a way that reverses
    between files: `urban_scale_07.dev7.nc` has them on 23 of 34 inputs and none
    of its 24 results, while the older flat files have them on the results and
    almost nothing else.

    Not two answers to one question. Calliope copies the declared unit onto the
    array, so where both speak they say the same thing — the same relationship
    the catalogue's `colors` already has with the Arrow field metadata.
    """
    synthetic = SYNTHETIC_VARIABLES.get(variable)
    if synthetic is not None:
        return synthetic.unit
    if variable in dataset:
        unit = dataset[variable].attrs.get("unit")
        if unit:
            return str(unit)
    return str((declared or {}).get(variable, ""))


def build_catalog(
    dataset: xr.Dataset,
    transmission_techs: Iterable[str] = (),
    declared_units: Mapping[str, str] | None = None,
) -> VariableCatalog:
    """Categorises a dataset's variables.

    Args:
        dataset: The merged results and inputs.
        transmission_techs: Techs whose presence makes a variable link-relevant.
        declared_units: Units Calliope's math declares, keyed by component name,
            used where an array carries none of its own. Injected rather than
            imported: reading the math is `modeldef`'s, and `results` may not
            reach sideways for it.
    """
    transmission_techs = list(transmission_techs)
    variables = list(dataset.data_vars)
    static = [name for name in variables if "timesteps" not in dataset[name].dims]
    timeseries = [name for name in variables if "timesteps" in dataset[name].dims]
    available = [
        variable
        for variable in SYNTHETIC_VARIABLES.values()
        if variable.is_available(dataset)
    ]
    synthetic = [variable.name for variable in available]
    dims: dict[str, tuple[str, ...]] = {
        str(name): tuple(str(dim) for dim in dataset[name].dims) for name in variables
    }
    dims.update(
        {variable.name: _synthetic_dims(dataset, variable) for variable in available}
    )
    units = {
        name: unit
        for name in list(dims)
        if (unit := unit_for(dataset, name, declared_units))
    }
    return VariableCatalog(
        all=tuple(sorted(variables)),
        timeseries=tuple(sorted(timeseries + synthetic)),
        static=tuple(sorted(static)),
        dims=dims,
        units=units,
        static_nodes=tuple(
            sorted(name for name in static if "nodes" in dataset[name].dims)
        ),
        static_links=tuple(
            sorted(
                name
                for name in static
                if _has_transmission_data(dataset[name], transmission_techs)
            )
        ),
    )


def get_array(dataset: xr.Dataset, variable: str) -> xr.DataArray:
    """Returns a variable's array, computing it if it is synthetic."""
    synthetic = SYNTHETIC_VARIABLES.get(variable)
    if synthetic is not None:
        return synthetic.compute(dataset).rename(variable)
    return dataset[variable]


def base_tech_members(model, base_tech: str | list) -> list[str]:
    """Every tech whose base tech is, or is among, `base_tech`."""
    inputs = model.inputs
    if "base_tech" not in inputs:
        return []
    return sorted(
        inputs.base_tech.where(inputs.base_tech.isin(base_tech), drop=True)
        .techs.to_index()
        .to_list()
    )


def tech_base_techs(model) -> dict[str, str]:
    """Each technology's base tech, as Calliope resolved it.

    The whole map rather than one slice of it, because the results sidebar groups
    the technologies by it. Read from `inputs` for the same reason
    `colors.tech_colors` is: this is also asked of a model that has been resolved
    but not solved, whose `results` is empty.

    A technology Calliope left without a base tech is simply absent, so the caller
    can tell "unclassified" from "classified as something we did not expect".
    """
    inputs = model.inputs
    if "base_tech" not in inputs:
        return {}
    return {
        str(tech): str(base_tech)
        for tech, base_tech in inputs.base_tech.to_series().dropna().items()
    }


def dimension_members(dataset: xr.Dataset, ignore: Iterable[str] = ()) -> dict:
    """The members of each dimension, for building selection controls."""
    ignored = set(ignore)
    return {
        str(name): [str(value) for value in dataset[name].to_index()]
        for name in dataset.coords
        if str(name) not in ignored and name != "timesteps"
    }
