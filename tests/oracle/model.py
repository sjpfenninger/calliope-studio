from pathlib import Path

import calliope
import pandas as pd
import xarray as xr

from calligraph.data.colors import tech_colors
from calligraph.data.query import filter_selectors
from calligraph.data.variables import (
    SYNTHETIC_VARIABLES,
    VariableCatalog,
    build_catalog,
)


class ModelData:
    """Data access layer around a solved Calliope model.

    Wraps a Calliope NetCDF file and provides categorised variable listings
    and tidy-DataFrame accessors for visualisation. Holds no UI state.
    """

    def __init__(self, path: str | Path):
        """Returns a new ModelData from the given `path` to a Calliope NetCDF file.

        Args:
            path (str | Path)
        """
        self.model = calliope.read_netcdf(path)
        self.dataset = xr.merge(
            [self.model.results, self.model.inputs], compat="override"
        )
        self.tech_colors = tech_colors(self.model)

    @property
    def name(self) -> str:
        return self.model.name or "Unnamed model"

    def catalog(self, include_inputs: bool = True) -> VariableCatalog:
        """Returns a `VariableCatalog` for this model's variables.

        Args:
            include_inputs: If False, only results variables are catalogued.
        """
        dataset = self.dataset if include_inputs else self.model.results
        return build_catalog(
            dataset, transmission_techs=self.base_tech_members("transmission")
        )

    def get_array(self, variable: str) -> xr.DataArray:
        """Returns the DataArray for `variable`, resolving synthetic variables."""
        synthetic = SYNTHETIC_VARIABLES.get(variable)
        if synthetic is not None:
            return synthetic.compute(self.dataset).rename(variable)
        return self.dataset[variable]

    def static_frame(
        self, variable: str, selectors: dict = None, *, drop_zeros: bool = True
    ) -> pd.DataFrame:
        """Returns a tidy DataFrame of a static (non-timeseries) variable.

        Args:
            variable: Variable name.
            selectors: Mapping of dimension name to list of members to keep.
            drop_zeros: Drop all-zero entries (as well as NaNs, always dropped).
        """
        da = self.get_array(variable)
        series = da.sel(filter_selectors(da, selectors or {})).to_series()
        if drop_zeros:
            series = series.where(lambda x: x != 0)
        return series.dropna().to_frame(variable).reset_index()

    def timeseries_frame(
        self,
        variable: str,
        selectors: dict = None,
        *,
        time_range: tuple = None,
        resample: str = None,
        sum_by: str = "nodes",
    ) -> pd.DataFrame:
        """Returns a tidy DataFrame of a timeseries variable.

        Args:
            variable: Variable name, including synthetic variables like "flow*".
            selectors: Mapping of dimension name to list of members to keep.
            time_range: Optional (start, end) subset applied to `timesteps`.
            resample: Optional pandas offset alias (e.g. "1D") to resample to (mean).
            sum_by: Optional dimension to sum over, if present.
        """
        da = self.get_array(variable)
        da = da.sel(filter_selectors(da, selectors or {}))

        if resample:
            da = da.resample(timesteps=resample).mean()

        if time_range:
            da = da.sel(timesteps=slice(*time_range))

        if sum_by and sum_by in da.dims:
            da = da.sum(sum_by)

        return da.to_series().to_frame(variable).reset_index()

    def table_frame(
        self, variable: str, selectors: dict = None, *, dropna: bool = False
    ) -> pd.DataFrame:
        """Returns an untidied DataFrame of a variable, for tabular display."""
        da = self.get_array(variable)
        df = da.sel(filter_selectors(da, selectors or {})).to_dataframe()
        if dropna:
            df = df.dropna()
        return df

    def base_tech_members(self, base_tech: str | list) -> list:
        """Returns all techs whose base tech is (in) `base_tech`."""
        return sorted(
            self.model.inputs.base_tech.where(
                self.model.inputs.base_tech.isin(base_tech), drop=True
            )
            .techs.to_index()
            .to_list()
        )

    def coords(self, ignore=("timesteps", "techs")) -> list:
        """Returns the model's coordinate names, minus those in `ignore`."""
        coords = set(self.model.results.coords)
        if ignore:
            coords = coords - set(ignore)
        return sorted(coords)

    def transmission_groups(self, group_param: str = None, techs: list = None) -> dict:
        """Returns a grouping of transmission techs by a model input parameter.

        Args:
            group_param: Model input variable to group by. If empty or None,
                each tech forms its own group.
            techs: Transmission techs to group; defaults to all of them.

        Raises:
            KeyError: If `group_param` is not a model input variable.
        """
        if techs is None:
            techs = self.base_tech_members("transmission")
        if not group_param:
            return {tech: [tech] for tech in techs}
        if group_param not in self.model.inputs:
            raise KeyError(
                f"'{group_param}' is not an input variable of this model, "
                "so cannot be used to group transmission techs."
            )
        groups = (
            self.model.inputs[group_param]
            .sel(techs=techs)
            .to_dataframe()
            .groupby(group_param)
            .groups
        )
        return {group: list(members) for group, members in groups.items()}
