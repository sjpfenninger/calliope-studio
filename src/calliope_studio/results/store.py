"""Opening Calliope models and keeping them around.

Loading a `.nc` is expensive — roughly seventeen times its file size in memory,
and a second or more of xarray and Calliope import cost — so handles are cached
and the raw arrays never leave the process. Everything the frontend receives is
an aggregate computed here.

"Results" is the older half of what this layer does. What it really owns is *a
loaded Calliope model*, which is also what the editor needs when it wants to know
what a definition means rather than what its files say: a resolved-but-unsolved
model is the same artefact with an empty `results`. `load` is the entry point for
that — same cache, same byte budget, and deliberately no handle, because a handle
is a URL and an unsolved model has no results to serve under one.
"""

import hashlib
import os
import threading
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
CACHE_BUDGET_ENV_VAR = "CALLIOPE_STUDIO_RESULTS_BUDGET_MB"
DEFAULT_BUDGET_MB = 2048


class ResultsNotFound(KeyError):
    """Raised when a results handle is unknown or its file has gone."""


def results_id(path: Path) -> str:
    """A stable handle for a results file, derived from its resolved path."""
    return hashlib.sha256(str(Path(path).resolve()).encode()).hexdigest()[:16]


@dataclass(frozen=True)
class LoadedModel:
    """What a solved model is, to everything outside the worker.

    Six attributes, which is the entire `calliope.Model` surface this
    application ever touched — `colors`, `catalog` and `geo` read `inputs`,
    `links` reads `definition`, `summaries` reads `config` and `runtime`, and
    every query already worked on `handle.dataset`. Reproducing those six is what
    lets this module read a `.nc` **without importing Calliope at all**, which is
    the strongest form of the layering rule `results/` already lives under and
    what makes the layer usable from a notebook with no Calliope installed.

    It is also what makes the layer version-tolerant. `calliope.read_netcdf`
    constructs a `Model`, and a `Model` insists on math the installed version
    understands — so seven of the eleven sample `.nc` files in this repository,
    every one written before 0.7.0.dev7, failed to open at all with
    `ModelError: Requested math 'base' was not initialised`. Nothing about
    reading a results file needs that object.

    `config`, `definition`, `runtime` and `math` are plain dicts rather than
    Calliope's pydantic models, for the same reason: a pydantic model is this
    version's schema, and an older file is not obliged to satisfy it.
    """

    name: str
    inputs: xr.Dataset
    results: xr.Dataset
    config: dict
    definition: dict
    runtime: dict
    math: dict
    #: What wrote the file, for reporting — never for deciding how to read it.
    calliope_version: str | None = None


@dataclass(frozen=True)
class ResultHandle:
    """A loaded Calliope model. `dataset` is inputs-only if it was not solved."""

    id: str
    path: Path
    model: LoadedModel
    dataset: xr.Dataset

    @property
    def name(self) -> str:
        return getattr(self.model, "name", None) or self.path.stem


#: Groups a Calliope 0.7.0.dev7-and-later `.nc` is written as. Their presence is
#: what identifies the layout — never the version string, because
#: `urban_scale_07.dev7.nc` reports `calliope_version_initialised = 0.7.0.dev6`
#: while using dev7's layout, and a reader that trusted it would take the wrong
#: branch on a real file this repository ships.
GROUPED_LAYOUT = ("inputs", "results", "attrs")

#: Attributes Calliope encodes on the way out, and the decoding each needs.
#: Mirrors `calliope.io._deserialise`, which cannot be imported here.
_SERIALISED_KEYS = (
    "serialised_dicts",
    "serialised_bools",
    "serialised_nones",
    "serialised_single_element_list",
    "serialised_sets",
)


def _listify(value):
    """`calliope.util.tools.listify`, reproduced.

    A string is one item, not a list of characters — which is the whole reason
    Calliope has this rather than calling `list()`.
    """
    if value is None:
        return []
    if not isinstance(value, str) and hasattr(value, "__iter__"):
        return list(value)
    return [value]


def _deserialise(attrs: dict) -> dict:
    """Undoes the encoding Calliope applies to netCDF attributes.

    netCDF attributes are scalars, strings and arrays, so Calliope writes a dict
    as YAML, a bool as an int, None as a string and a set as a list — and records
    which keys got which treatment in `serialised_*` attributes beside them. That
    bookkeeping is the only way back: nothing about the stored value says whether
    `1` was an integer or True.

    Reimplemented rather than imported because this module may not import
    Calliope — which is the point of the whole reader. It is copied from
    `calliope.io._deserialise` and must stay equal to it; the sample files across
    four Calliope versions are what checks that.

    Returns a new dict; the caller's is left alone.
    """
    out = dict(attrs)
    encoded = {key: _listify(out.pop(key, [])) for key in _SERIALISED_KEYS}

    for name in encoded["serialised_dicts"]:
        if name in out:
            out[name] = _parse_yaml(out[name])
    for name in encoded["serialised_bools"]:
        if name in out:
            out[name] = bool(out[name])
    for name in encoded["serialised_nones"]:
        out[name] = None
    for name in encoded["serialised_single_element_list"]:
        if name in out:
            out[name] = _listify(out[name])
    for name in encoded["serialised_sets"]:
        if name in out:
            out[name] = set(_listify(out[name]))
    return out


def _parse_yaml(text):
    """A serialised dict attribute, as a plain dict.

    `typ="safe"` because this is data from a file the user opened, and a Calliope
    `.nc` has no business constructing Python objects on load. Anything
    unreadable becomes an empty dict rather than taking the whole open down: a
    model whose `definition` will not parse is still a model whose *results* are
    perfectly good, and the results are what was asked for.
    """
    if not isinstance(text, str):
        return text if isinstance(text, dict) else {}
    try:
        from ruamel.yaml import YAML

        parsed = YAML(typ="safe").load(text)
    except Exception:
        return {}
    return parsed if isinstance(parsed, dict) else {}


class UnreadableResults(ValueError):
    """Raised when a `.nc` is not a Calliope model this build can make sense of.

    Reported rather than guessed at. The reader covers the two layouts Calliope
    has actually written; a third would be a future version, and inventing an
    interpretation of it produces numbers that are wrong in a way nobody can see.
    """


def _open_group(path: Path, group: str | None) -> xr.Dataset | None:
    """One netCDF group as a dataset, or None if it cannot be read.

    `OSError` is what xarray raises for a missing group, which is the same thing
    Calliope's own reader catches — the file is fine, that part of it simply does
    not exist. A results-free model is the ordinary case for a resolution.

    `ValueError` is the other half, and catching only `OSError` was a hole:
    xarray raises it — *"did not find a match in any of xarray's currently
    installed IO backend"* — when a file is so unlike netCDF that no backend will
    claim it, which is precisely a renamed CSV, a truncated download or an empty
    file. Those escaped as that message, naming xarray's plugin machinery to
    somebody who had merely opened the wrong file.

    Which absence is fatal is the caller's decision: a missing `results` group is
    ordinary, a missing root group means there is no model here at all.

    **The open and the load are caught separately, and only the open is
    forgiven.** `ValueError` means two different things depending on where it
    comes from: raised by `open_dataset` it is "no backend claimed this file",
    raised by `load()` it is a real array that will not decode — a bad time unit,
    a corrupt chunk. Catching both together would turn the second into a silently
    empty `results` group, so a chart would draw nothing where it should have
    failed loudly.
    """
    try:
        opened = xr.open_dataset(path, group=group)
    except OSError:
        return None  # the group is not in this file
    except ValueError:
        return None  # nothing will claim this file at all
    with opened:
        return opened.load()


def _decode_variables(dataset: xr.Dataset) -> xr.Dataset:
    """Applies Calliope's attribute decoding to every array in a dataset.

    Per variable as well as per dataset because `unit`, `title` and `default` are
    written on the arrays, and `results/catalog.py` reads them to label a chart.
    """
    for array in dataset.data_vars.values():
        array.attrs = _deserialise(array.attrs)
    return dataset


def _read_grouped(path: Path) -> LoadedModel | None:
    """A 0.7.0.dev7-and-later file: `inputs`, `results` and `attrs` groups.

    The `attrs` group holds no variables at all — `config`, `definition`,
    `runtime` and the whole applied `math` are netCDF *attributes* on it,
    serialised as YAML.
    """
    inputs = _open_group(path, "inputs")
    if inputs is None:
        return None
    results = _open_group(path, "results")
    attrs_group = _open_group(path, "attrs")
    meta = _deserialise(attrs_group.attrs) if attrs_group is not None else {}

    runtime = meta.get("runtime") or {}
    return LoadedModel(
        name=str(meta.get("name") or runtime.get("name") or path.stem),
        inputs=_decode_variables(inputs),
        results=_decode_variables(results if results is not None else xr.Dataset()),
        config=meta.get("config") or {},
        definition=meta.get("definition") or {},
        runtime=runtime,
        math=meta.get("math") or {},
        calliope_version=_version_from(runtime, meta),
    )


def _read_flat(path: Path) -> LoadedModel:
    """A 0.7.0.dev6-and-earlier file: one dataset, split on `is_result`.

    The split is per variable, and a variable that does not say is treated as an
    input. That is the safe direction: `inputs` is what the map, the colours and
    the catalogue read, and a result mistaken for an input is visible in the
    interface, where an input mistaken for a result silently vanishes from it.

    Metadata is thinner here than in the grouped layout and differently spelled —
    `applied_math` in dev6, `math` before it, `def_path` against `_model_def_dict`
    — so this reads what is there and leaves the rest empty rather than
    reconstructing something Calliope never wrote.
    """
    root = _open_group(path, None)
    if root is None:
        # Both layouts have now declined it, so this is the end of the line.
        # The message says what was tried, because the two likely causes want
        # opposite responses: a file that is not a model at all is the user's
        # to correct, while one written by a newer Calliope is ours.
        raise UnreadableResults(
            f"{path.name} is not a Calliope results file this build can read. "
            "It is neither a grouped (0.7.0.dev7 and later) nor a flat "
            "(0.7.0.dev6 and earlier) model, and may not be netCDF at all."
        )

    meta = _deserialise(root.attrs)
    result_names = [
        name
        for name, array in root.data_vars.items()
        if bool(array.attrs.get("is_result", 0))
    ]
    input_names = [name for name in root.data_vars if name not in result_names]

    results = _decode_variables(root[result_names])
    inputs = _decode_variables(root[input_names])
    # `is_result` has done its job and is an implementation detail of a layout
    # nothing downstream knows about.
    for dataset in (inputs, results):
        for array in dataset.data_vars.values():
            array.attrs.pop("is_result", None)

    return LoadedModel(
        name=str(meta.get("name") or path.stem),
        inputs=inputs,
        results=results,
        config=meta.get("config") or {},
        definition=meta.get("_model_def_dict") or {},
        runtime=_runtime_from_flat(meta),
        math=meta.get("applied_math") or meta.get("math") or {},
        calliope_version=_version_from({}, meta),
    )


def _runtime_from_flat(meta: dict) -> dict:
    """The handful of runtime facts an old file records, under dev7's names.

    dev7 gathered these into a `runtime` mapping; before it they were loose root
    attributes. Translated here so `results/summaries.py` has one shape to read
    and does not grow a branch per Calliope version.
    """
    runtime = {
        key: meta[key]
        for key in (
            "termination_condition",
            "applied_overrides",
            "scenario",
            "calliope_version_defined",
            "calliope_version_initialised",
        )
        if key in meta
    }
    timings = {
        key: meta[key]
        for key in meta
        if isinstance(key, str) and key.startswith("timestamp_")
    }
    if timings:
        runtime["timings"] = timings
    return runtime


def _version_from(runtime: dict, meta: dict) -> str | None:
    """What wrote the file, for display only.

    Deliberately never consulted to choose a branch — see `GROUPED_LAYOUT`.
    """
    for source in (runtime, meta):
        for key in ("calliope_version_initialised", "calliope_version_defined"):
            value = source.get(key)
            if value:
                return str(value)
    return None


def _read(path_str: str) -> ResultHandle:
    path = Path(path_str)
    model = _read_grouped(path) or _read_flat(path)
    # Results and inputs merged into one namespace, so that a variable can be
    # requested by name without the caller knowing which side it came from.
    # `override` because the two legitimately share coordinate variables.
    dataset = xr.merge([model.results, model.inputs], compat="override")

    # Read eagerly, so nothing touches the file again after this returns.
    #
    # Two reasons, both learned the hard way. xarray leaves a netCDF-backed
    # dataset lazy, so an array is fetched on first *use* — which happens on some
    # other request, on some other thread, at which point netCDF4's global lock
    # is a deadlock waiting to happen (this whole function is serialised below for
    # the same reason). And a lazily-backed dataset outlives its file: the editor's
    # resolutions are superseded and deleted, and a model still reading from one is
    # reading from a file that is gone.
    #
    # It costs nothing in practice: the byte budget already assumes a loaded model
    # is resident, and every query reads the arrays anyway.
    for eager in (model.inputs, model.results, dataset):
        try:
            eager.load()
        except (AttributeError, OSError, ValueError):
            # A model with no results, or a variable xarray cannot decode. Neither
            # is worth failing the open for; it simply stays lazy.
            pass

    return ResultHandle(id=results_id(path), path=path, model=model, dataset=dataset)


class _ModelCache:
    """A byte-budgeted LRU of loaded models.

    Replaces an `lru_cache`, which cannot express a budget in bytes, cannot be
    evicted selectively, and holds a strong reference for ever — so `forget` used
    to free nothing at all, and deleting a run left its solved model resident.

    At least one entry is always retained: a single model larger than the whole
    budget must still be openable, or the application simply cannot show it.

    **Loading is serialised.** netCDF4 is not thread-safe, and two threads opening
    the same file deadlock inside it — permanently, taking the whole server with
    them, since FastAPI runs every sync endpoint in a threadpool. That was
    reproducible with eight concurrent requests for the same model, and the stack
    was eight threads in `netCDF4_._getitem`. Two run tabs opening one results file
    at the same moment is the same thing. Holding the lock across the read means one
    request waits for the other's load, which is what the cache is for anyway.
    """

    def __init__(self) -> None:
        self._entries: "OrderedDict[str, ResultHandle]" = OrderedDict()
        self._costs: dict[str, int] = {}
        self._lock = threading.RLock()

    def budget(self) -> int:
        """The budget in bytes, read at call time so a test can set it."""
        raw = os.environ.get(CACHE_BUDGET_ENV_VAR)
        megabytes = int(raw) if raw and raw.isdigit() else DEFAULT_BUDGET_MB
        return megabytes * 1024 * 1024

    def get(self, path_str: str) -> ResultHandle:
        with self._lock:
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
        with self._lock:
            self._entries.pop(path_str, None)
            self._costs.pop(path_str, None)


_cache = _ModelCache()


def _load(path_str: str) -> ResultHandle:
    """Loads a solved model, from the cache when it is already resident."""
    return _cache.get(path_str)


def load(path: Path) -> ResultHandle:
    """Loads any Calliope `.nc`, solved or not, through the shared byte budget.

    For callers that have a path and no handle — the editor's resolved model
    definitions. Note the cache keys purely on the resolved path with no mtime
    component, which is right for an immutable `results.nc` and means a caller
    whose file *can* change must give each version its own path.
    """
    return _load(str(Path(path).resolve()))


def release(path: Path) -> None:
    """Drops a loaded model, so a superseded file stops occupying the budget."""
    _cache.drop(str(Path(path).resolve()))


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
