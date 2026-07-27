from dataclasses import dataclass
from typing import Callable, Iterable

import xarray as xr


@dataclass(frozen=True)
class SyntheticVariable:
    """A variable computed on demand from other variables in a dataset.

    Attributes:
        name: Name under which the variable is listed and requested.
        requires: Variables that must be present in the dataset.
        dims_like: Existing variable whose dimensions the computed variable shares.
        compute: Computes the variable from a dataset containing `requires`.
    """

    name: str
    requires: tuple
    dims_like: str
    compute: Callable[[xr.Dataset], xr.DataArray]

    def is_available(self, dataset: xr.Dataset) -> bool:
        return all(var in dataset.data_vars for var in self.requires)


SYNTHETIC_VARIABLES: dict[str, SyntheticVariable] = {
    "flow*": SyntheticVariable(
        name="flow*",
        requires=("flow_out", "flow_in"),
        dims_like="flow_out",
        compute=lambda ds: ds.flow_out.fillna(0) - ds.flow_in.fillna(0),
    )
}


@dataclass(frozen=True)
class VariableCatalog:
    """Categorised variable names for a given dataset.

    Attributes:
        all: All variables in the dataset.
        timeseries: Variables with a `timesteps` dimension, including synthetic ones.
        static: Variables without a `timesteps` dimension.
        static_nodes: Static variables with a `nodes` dimension.
        static_links: Static variables with data on at least one transmission tech.
    """

    all: tuple
    timeseries: tuple
    static: tuple
    static_nodes: tuple
    static_links: tuple


def _has_transmission_data(da: xr.DataArray, transmission_techs: list) -> bool:
    if "techs" not in da.dims:
        return False
    techs = [t for t in transmission_techs if t in da.techs.to_index()]
    if not techs:
        return False
    return bool(da.sel(techs=techs).notnull().any())


def build_catalog(
    dataset: xr.Dataset, transmission_techs: Iterable[str] = ()
) -> VariableCatalog:
    """Categorise the variables of `dataset` into a `VariableCatalog`.

    Args:
        dataset: Dataset to categorise, e.g. `ModelData.dataset`.
        transmission_techs: Techs whose data qualifies a variable as link-relevant.
    """
    transmission_techs = list(transmission_techs)
    variables = list(dataset.data_vars)
    timeseries = [var for var in variables if "timesteps" in dataset[var].dims]
    static = [var for var in variables if "timesteps" not in dataset[var].dims]
    synthetic = [
        syn.name for syn in SYNTHETIC_VARIABLES.values() if syn.is_available(dataset)
    ]
    return VariableCatalog(
        all=tuple(sorted(variables)),
        timeseries=tuple(sorted(timeseries + synthetic)),
        static=tuple(sorted(static)),
        static_nodes=tuple(
            sorted(var for var in static if "nodes" in dataset[var].dims)
        ),
        static_links=tuple(
            sorted(
                var
                for var in static
                if _has_transmission_data(dataset[var], transmission_techs)
            )
        ),
    )
