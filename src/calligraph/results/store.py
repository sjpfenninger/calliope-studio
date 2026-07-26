"""Opening solved models and keeping them around.

Loading a `.nc` is expensive — roughly seventeen times its file size in memory,
and a second or more of xarray and Calliope import cost — so handles are cached
and the raw arrays never leave the process. Everything the frontend receives is
an aggregate computed here.
"""

import hashlib
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import xarray as xr

#: How many solved models to keep loaded at once. Each is large, and comparing
#: a handful of runs is the realistic upper bound on what anyone looks at.
CACHE_SIZE = 8


class ResultsNotFound(KeyError):
    """Raised when a results handle is unknown or its file has gone."""


def results_id(path: Path) -> str:
    """A stable handle for a results file, derived from its resolved path."""
    return hashlib.sha256(str(Path(path).resolve()).encode()).hexdigest()[:16]


@dataclass(frozen=True)
class ResultHandle:
    """A loaded, solved model."""

    id: str
    path: Path
    model: "object"  # calliope.Model, untyped to keep the import lazy
    dataset: xr.Dataset

    @property
    def name(self) -> str:
        return getattr(self.model, "name", None) or self.path.stem


@lru_cache(maxsize=CACHE_SIZE)
def _load(path_str: str) -> ResultHandle:
    import calliope

    path = Path(path_str)
    model = calliope.read_netcdf(path)
    # Results and inputs merged into one namespace, so that a variable can be
    # requested by name without the caller knowing which side it came from.
    # `override` because the two legitimately share coordinate variables.
    dataset = xr.merge([model.results, model.inputs], compat="override")
    return ResultHandle(id=results_id(path), path=path, model=model, dataset=dataset)


class ResultStore:
    """Maps handles to results files, and loads them on demand."""

    def __init__(self) -> None:
        self._paths: dict[str, Path] = {}

    def register(self, path: Path) -> str:
        """Records a results file and returns its handle.

        Registering does not load it; that happens on first use.
        """
        resolved = Path(path).resolve()
        handle = results_id(resolved)
        self._paths[handle] = resolved
        return handle

    def get(self, handle: str) -> ResultHandle:
        """Loads the results for a handle, from cache when possible."""
        path = self._paths.get(handle)
        if path is None or not path.is_file():
            raise ResultsNotFound(handle)
        return _load(str(path))

    def forget(self, handle: str) -> None:
        self._paths.pop(handle, None)
