"""Rendered math, kept on disk and keyed by what it was rendered from.

Rendering is the most expensive thing this application does short of a solve:
`add_optimisation_components()` is 4.2 s on `national_scale` and 8.0 s on
`urban_scale`, against 0.5 s to load the model and 0.11 s to build the backend.
All of it is parsing, all of it is deterministic, and Calliope Studio is launched
per session — so without this, the first Math tab of every session pays it again
for an answer that has not changed since the last one.

**The key is not (version, math file), and the difference matters.** Of the 114
components `national_scale` and `urban_scale` both take from `base` alone, 86
render identically and 28 do not: `\\textit{available\\_area}` in one and
`\\textit{available\\_area}_\\text{node}` in the other. Subscripts come from
`LatexBackendModel._dims_to_var_string(values)`, the dims of *this model's* input
array, so a parameter set per node renders differently from one set once. Keying
on the math alone would serve one model's notation for another's, silently, which
is the worst kind of wrong answer this project can produce — wrong math looks
exactly like right math.

So the key covers everything the LaTeX backend reads:

- **The Calliope version**, because the renderer changes without the math
  changing — the jinja templates, the escaping filters, the subscript format.
- **`PAYLOAD_VERSION`**, because everything else in the key describes what the
  backend reads, and none of it moves when `mathdoc.render` changes what it
  builds *out* of that backend.
- **`math.init`**, which holds every named block as loaded, built-ins included.
  That makes it the *content* hash of the math files, so a development build
  shipping different math under an unchanged version string still gets its own
  entry. It is also what `mathdoc._origins` reads, so provenance is covered.
- **`math.build`**, the merged math the backend is actually handed.
- **The build config and `init.mode`**, which the backend takes directly and
  which selects the built-in math applied.
- **Each input array's dims, and which dimensions exist at all** — the
  subscripts, and the whole reason for the paragraph above.

Measured at 6 ms, which is why the caller can afford it on a request.

**The key covers the data too, since the payload came to depend on it.** It
did not at first — the notation reads only dims, and leaving values out let two
models with the same math and shapes share an entry — but `mathdoc` now marks a
component whose `where` matches nothing in *this* model as `unmatched`, and
that is decided from the values: an override zeroing a parameter a `where`
tests flips it. Two models sharing an entry on dims alone were served each
other's labelling. So each input array's bytes go into the material as well;
a digest of them is cheap against the render and, on the same model in a
later session, still hits. `mathdoc.check_inputs` stays on the hit path for
the `checks:` block all the same — it costs 0.11 s and is what a render would
have raised.
"""

import hashlib
import json
import os
import time
from pathlib import Path
from typing import Any

#: Suffix of a cache entry. Plain JSON so the directory can be read by a human
#: wondering what is in it and why it is that size.
SUFFIX = ".json"

#: The shape of what `mathdoc.render` produces, which the rest of the key knows
#: nothing about — every other entry describes what the *backend* reads, so a
#: change to how we turn a backend into a payload would be served from entries
#: written before it. **Bump this whenever `mathdoc.render`'s output changes.**
#: 2: components the math deactivates are listed rather than rendered.
#: 3: Calliope 0.7.0 — LaTeX read from `backend.math_strings`, metadata from
#:    the pydantic definitions, and the `postprocessed` group added.
#: 4: a component whose `where` matches nothing is marked `unmatched` instead
#:    of carrying an empty array block as its notation.
PAYLOAD_VERSION = 4


def fingerprint(model: Any) -> str:
    """What this model's math would render to, as a key.

    Args:
        model: An initialised `calliope.Model`. Need not be built or solved.

    Returns:
        A 16-character hex digest. Truncated because it names a file in a
        directory of a few dozen entries, not a content-addressed store.
    """
    import calliope

    material = {
        "payload": PAYLOAD_VERSION,
        "calliope": calliope.__version__,
        "math_init": model.math.init.model_dump(mode="json"),
        "math_build": model.math.build.model_dump(mode="json"),
        "build_config": model.config.build.model_dump(mode="json"),
        "mode": str(model.config.init.mode),
        # Sorted rather than dict order: xarray does not promise one, and a key
        # that changed when nothing did would be a cache that never hits.
        "shapes": sorted(
            (str(name), [str(dim) for dim in array.dims])
            for name, array in model.inputs.data_vars.items()
        ),
        "dims": sorted(str(dim) for dim in model.inputs.dims),
        "values": _values_digest(model.inputs),
    }
    raw = json.dumps(material, sort_keys=True, default=str).encode()
    return hashlib.sha256(raw).hexdigest()[:16]


def _values_digest(inputs: Any) -> str:
    """One digest over every input array's values, in a fixed order.

    Bytes rather than `repr`: a NaN's position is part of what `where` sees,
    and `tobytes` keeps it where `str` would not. Object arrays — strings,
    mostly — are stringified first, since their bytes are pointers.
    """
    import numpy as np

    digest = hashlib.sha256()
    for name in sorted(str(name) for name in inputs.data_vars):
        values = inputs[name].values
        if values.dtype.kind in "OU":
            values = np.asarray(values).astype(str)
        digest.update(name.encode())
        digest.update(str(values.dtype).encode())
        digest.update(np.ascontiguousarray(values).tobytes())
    return digest.hexdigest()


def read(directory: Path, key: str) -> dict | None:
    """The payload stored under `key`, or None if there is not a usable one.

    Reading counts as use: the entry's mtime is bumped so that `prune` evicts by
    what has gone unread rather than by what was written longest ago. A model
    somebody opens every day would otherwise be evicted by a morning of opening
    other people's.

    Never raises. A missing, truncated or unreadable entry must cost a render,
    which is what the caller does on None anyway — turning it into a failure
    would make a corrupt cache worse than no cache.
    """
    path = Path(directory) / f"{key}{SUFFIX}"
    try:
        entry = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    payload = entry.get("payload") if isinstance(entry, dict) else None
    if not isinstance(payload, dict):
        return None
    try:
        os.utime(path)
    except OSError:
        pass  # A read-only cache still serves; it just evicts by write order.
    return payload


def write(directory: Path, key: str, payload: dict, *, model_name: str = "") -> None:
    """Stores a rendering under `key`.

    The Calliope version and the applied math sources are recorded *inside* the
    entry as well as folded into the key, so the directory answers "what version
    was this, and what math was applied" by being read rather than by being
    reverse-engineered from a digest that cannot be inverted.

    Best-effort: a cache that cannot be written must not fail the request that
    produced a perfectly good rendering.
    """
    import calliope

    entry = {
        "calliope_version": calliope.__version__,
        "model_name": model_name,
        "math_sources": [source.get("name") for source in payload.get("priority", [])],
        "written_at": time.time(),
        "payload": payload,
    }
    path = Path(directory) / f"{key}{SUFFIX}"
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        # Written beside and renamed, so a reader can never see half an entry.
        # `read` would return None on one, which is safe but wastes eight seconds.
        temporary = path.with_suffix(f".{os.getpid()}.tmp")
        temporary.write_text(json.dumps(entry, allow_nan=False), encoding="utf-8")
        os.replace(temporary, path)
    except (OSError, ValueError):
        return


def prune(directory: Path, keep: int) -> None:
    """Removes the least recently read entries beyond `keep`.

    Mtime, which `read` bumps, so this is a real LRU rather than eviction by age
    of writing.
    """
    root = Path(directory)
    if not root.is_dir() or keep < 0:
        return

    # `write` renames `<key>.<pid>.tmp` into place, and a worker killed between
    # the two leaves the temporary behind — which is exactly what cancelling a
    # math render does to it. Globbing `*.json` counted none of them and removed
    # none of them, so each cancelled render left ~169 kB in the state directory
    # for ever. Swept unconditionally: a temporary belongs to a process that is
    # no longer writing, since `os.replace` is atomic.
    for stale in root.glob("*.tmp"):
        stale.unlink(missing_ok=True)

    def mtime(path: Path) -> float:
        try:
            return path.stat().st_mtime
        except OSError:
            return 0.0

    entries = sorted(root.glob(f"*{SUFFIX}"), key=mtime, reverse=True)
    for path in entries[keep:]:
        path.unlink(missing_ok=True)
