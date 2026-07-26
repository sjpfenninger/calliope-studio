"""Opening solved models and keeping them around.

Loading a `.nc` is expensive — roughly seventeen times its file size in memory,
and a second or more of xarray and Calliope import cost — so handles are cached
and the raw arrays never leave the process. Everything the frontend receives is
an aggregate computed here.
"""

import hashlib
import os
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable

import xarray as xr

#: How much memory a loaded model occupies relative to its file size — xarray
#: float64 arrays against a compressed netCDF. Measured, not guessed.
MEMORY_FACTOR = 17

#: How much memory to let loaded models occupy, in megabytes.
#:
#: A budget rather than a count. The cache used to keep eight, which was free
#: while at most one or two were ever live — but with several run tabs open, and
#: comparing runs being the point of the feature, eight `urban_scale` models is
#: 650 MB and eight real national models is thirteen gigabytes. The same number
#: is meaningless for both; the bound that matters is bytes.
CACHE_BUDGET_ENV_VAR = "CALLIGRAPH_RESULTS_BUDGET_MB"
DEFAULT_BUDGET_MB = 2048


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


def _read(path_str: str) -> ResultHandle:
    import calliope

    path = Path(path_str)
    model = calliope.read_netcdf(path)
    # Results and inputs merged into one namespace, so that a variable can be
    # requested by name without the caller knowing which side it came from.
    # `override` because the two legitimately share coordinate variables.
    dataset = xr.merge([model.results, model.inputs], compat="override")
    return ResultHandle(id=results_id(path), path=path, model=model, dataset=dataset)


class _ModelCache:
    """A byte-budgeted LRU of loaded models.

    Replaces an `lru_cache`, which cannot express a budget in bytes, cannot be
    evicted selectively, and holds a strong reference for ever — so `forget` used
    to free nothing at all, and deleting a run left its solved model resident.

    At least one entry is always retained: a single model larger than the whole
    budget must still be openable, or the application simply cannot show it.
    """

    def __init__(self) -> None:
        self._entries: "OrderedDict[str, ResultHandle]" = OrderedDict()
        self._costs: dict[str, int] = {}

    def budget(self) -> int:
        """The budget in bytes, read at call time so a test can set it."""
        raw = os.environ.get(CACHE_BUDGET_ENV_VAR)
        megabytes = int(raw) if raw and raw.isdigit() else DEFAULT_BUDGET_MB
        return megabytes * 1024 * 1024

    def get(self, path_str: str) -> ResultHandle:
        if path_str in self._entries:
            self._entries.move_to_end(path_str)
            return self._entries[path_str]

        handle = _read(path_str)
        self._entries[path_str] = handle
        try:
            self._costs[path_str] = Path(path_str).stat().st_size * MEMORY_FACTOR
        except OSError:
            self._costs[path_str] = 0
        self._evict()
        return handle

    def _evict(self) -> None:
        budget = self.budget()
        while len(self._entries) > 1 and sum(self._costs.values()) > budget:
            oldest, _ = self._entries.popitem(last=False)
            self._costs.pop(oldest, None)

    def drop(self, path_str: str) -> None:
        self._entries.pop(path_str, None)
        self._costs.pop(path_str, None)


_cache = _ModelCache()


def _load(path_str: str) -> ResultHandle:
    """Loads a solved model, from the cache when it is already resident."""
    return _cache.get(path_str)


class ResultStore:
    """Maps handles to results files, and loads them on demand."""

    def __init__(self, candidates: Callable[[], Iterable[Path]] | None = None) -> None:
        """
        Args:
            candidates: Called to enumerate results files that might correspond to
                an unrecognised handle. A handle is a hash of a path and therefore
                not invertible, so a handle this process never minted can only be
                resolved by hashing the paths it could have come from. Without it,
                a bookmarked or hard-refreshed results URL 404s after a restart.
                Injected rather than imported: `results` knows nothing about
                workspaces or run directories.
        """
        self._paths: dict[str, Path] = {}
        self._candidates = candidates or (lambda: ())

    def register(self, path: Path) -> str:
        """Records a results file and returns its handle.

        Registering does not load it; that happens on first use.
        """
        resolved = Path(path).resolve()
        handle = results_id(resolved)
        self._paths[handle] = resolved
        return handle

    def path_for(self, handle: str) -> Path | None:
        """The file behind a handle, without loading it.

        Callers that only need to know *where* the results came from should not
        pay to deserialise a multi-gigabyte model to find out.
        """
        path = self._paths.get(handle)
        if path is None:
            path = self._discover(handle)
        return path if path is not None and path.is_file() else None

    def _discover(self, handle: str) -> Path | None:
        for candidate in self._candidates():
            resolved = Path(candidate).resolve()
            if results_id(resolved) == handle and resolved.is_file():
                self._paths[handle] = resolved
                return resolved
        return None

    def get(self, handle: str) -> ResultHandle:
        """Loads the results for a handle, from cache when possible."""
        path = self.path_for(handle)
        if path is None:
            raise ResultsNotFound(handle)
        return _load(str(path))

    def forget(self, handle: str) -> None:
        """Stops tracking a handle, and releases the model it had loaded."""
        path = self._paths.pop(handle, None)
        if path is not None:
            _cache.drop(str(path))
