from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Dict, List

import pandas as pd
import xarray as xr

if TYPE_CHECKING:
    from calligraph.data.model import ModelData


def filter_selectors(
    da: xr.DataArray, selectors: Dict[str, List[str]], additional_subset: Dict = None
) -> Dict[str, List[str]]:
    """Returns `selectors` reduced to those applicable to the given DataArray.

    Selector keys that are not dimensions of `da` (or whose value is None) are
    dropped. If `additional_subset` is given, its entries are intersected with
    the corresponding selector lists.
    """
    for k, v in selectors.items():
        assert v is None or isinstance(v, list)

    selector_keys_to_delete = [
        k for k in selectors.keys() if k not in da.dims or selectors[k] is None
    ]
    selectors = {k: v for k, v in selectors.items() if k not in selector_keys_to_delete}

    if additional_subset:
        for k, v in additional_subset.items():
            if k in selectors:
                selectors[k] = [i for i in v if i in selectors[k]]
            else:
                selectors[k] = v

    return selectors


@dataclass(frozen=True)
class Query:
    """A serialisable description of a data request against a model.

    Attributes:
        variable: Variable name, including synthetic variables like "flow*".
        selectors: Mapping of dimension name to list of members to keep.
        time_range: Optional (start, end) subset applied to `timesteps`.
        resample: Optional pandas offset alias (e.g. "1D") to resample to.
        sum_by: Optional dimension to sum over.
    """

    variable: str
    selectors: dict = field(default_factory=dict)
    time_range: tuple = None
    resample: str = None
    sum_by: str = None


def run_query(model: "ModelData", query: Query) -> pd.DataFrame:
    """Runs `query` against `model`, returning a tidy DataFrame.

    Timeseries variables are dispatched to `ModelData.timeseries_frame`,
    all others to `ModelData.static_frame`.
    """
    if query.variable in model.catalog().timeseries:
        return model.timeseries_frame(
            query.variable,
            query.selectors,
            time_range=query.time_range,
            resample=query.resample,
            sum_by=query.sum_by,
        )
    return model.static_frame(query.variable, query.selectors)
