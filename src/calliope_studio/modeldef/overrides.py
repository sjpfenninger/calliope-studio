"""Overrides as a flat list of settings, without restructuring the file.

An override is an arbitrary partial model. It can set anything the model can —
`config`, `data_tables`, `data_definitions`, `techs`, `nodes` — at any depth, in
nested or dot-notation form, freely mixed. A fully structured editor for one would
be the entire editor again, recursively, so the editor shows each override as the
list of settings it makes, one row per leaf:

    config.init.subset.timesteps    ["2005-01", "2005-01"]
    config.init.resample.timesteps  6h

Flattening to dotted paths is how Calliope reads them anyway, it handles arbitrary
depth without a bespoke form per section, and it makes the one question a user
actually has — *what does this override change?* — answerable at a glance.

**Displaying flattened must not mean writing flattened.** An override written as
nested YAML has to stay nested, and one written with a dotted key has to keep it.
`set_path` therefore resolves a path against the structure already in the file
rather than imposing one, creating intermediate keys only where the path is
genuinely new. `yaml_io._merge` already applies that principle key by key; this
extends it to a path.

The dotted display is inherently ambiguous — `config.init.mode` could be written
as three nested keys, as `config.init:` containing `mode:`, or as a single key
`config.init.mode:`, and Calliope accepts all three. Resolving against what is
already there is what makes the ambiguity harmless: whichever spelling the file
uses is the one that gets edited.
"""

from typing import Any

#: Keys that mark a mapping as *being* a value rather than a container of
#: settings.
#:
#: Calliope has two such mappings: an inline indexed parameter
#: (`{data: [...], index: [...], dims: techs}`) and a data table
#: (`{table: path, rows: ...}` — `data:` before 0.7.0, kept so an unmigrated
#: file still edits sanely). Splitting either into separate rows would let a
#: user edit `index` without `data` and produce an invalid pair, so they stay
#: one row and are edited as a unit.
VALUE_MARKERS = frozenset({"data", "table"})


def is_value(candidate: Any) -> bool:
    """Whether a node should be shown as one setting rather than descended into."""
    if not isinstance(candidate, dict):
        return True
    # An empty mapping has no leaves, so descending would lose the setting.
    return not candidate or not VALUE_MARKERS.isdisjoint(candidate)


def flatten(mapping: Any, prefix: str = "") -> dict[str, Any]:
    """Every setting a mapping makes, as `{dotted path: value}`.

    Insertion-ordered, so the editor can show settings in the order they were
    written rather than alphabetically.

    Args:
        mapping: The override body, or any nested part of one.
        prefix: Path accumulated so far; callers do not pass this.
    """
    if not isinstance(mapping, dict):
        return {prefix: mapping} if prefix else {}

    flat: dict[str, Any] = {}
    for key, value in mapping.items():
        path = f"{prefix}.{key}" if prefix else str(key)
        if is_value(value):
            flat[path] = value
        else:
            flat.update(flatten(value, path))
    return flat


def _split_at_existing(container: Any, parts: list[str]) -> tuple[Any, int]:
    """Descends as far as the document already goes.

    Returns:
        The deepest existing container, and how many path components it consumed.

    Prefers the longest matching key at each level, so a file written with
    `config.init:` is edited in place rather than gaining a second, nested
    `config:` block that says the same thing.
    """
    consumed = 0
    while consumed < len(parts) and isinstance(container, dict):
        matched = None
        for length in range(len(parts) - consumed, 0, -1):
            key = ".".join(parts[consumed : consumed + length])
            if key in container:
                matched = (key, length)
                break
        if matched is None:
            break

        key, length = matched
        if consumed + length == len(parts):
            # The leaf itself exists; stop one level above it.
            return container, consumed

        nxt = container[key]
        if not isinstance(nxt, dict) or is_value(nxt):
            # The path continues past something that is not a container. Treat
            # the rest as new rather than silently replacing a value with a dict.
            break
        container = nxt
        consumed += length

    return container, consumed


def set_path(document: dict, path: str, value: Any) -> dict:
    """Sets one leaf, in place, without reshaping anything else.

    Args:
        document: An override body. Mutated.
        path: A dotted path, as produced by `flatten`.
        value: The new value.

    Returns:
        The same document, for convenience.

    Raises:
        ValueError: If `path` is empty.
    """
    parts = [part for part in path.split(".") if part]
    if not parts:
        raise ValueError("A setting needs a path.")

    container, consumed = _split_at_existing(document, parts)
    remaining = parts[consumed:]

    # An existing leaf, whichever way it was spelled: assign to that exact key.
    # `_split_at_existing` stops one level above a leaf it found, so the whole
    # remainder is that leaf's key.
    key = ".".join(remaining)
    if isinstance(container, dict) and key in container:
        container[key] = value
        return document

    # Genuinely new. Nested keys, because that is the form a reader expects and
    # the one Calliope's own examples are written in.
    for part in remaining[:-1]:
        existing = container.get(part)
        if existing is not None and not isinstance(existing, dict):
            # Continuing past a scalar would mean either destroying it or writing
            # a key that contradicts it — a model cannot have `init` be both a
            # string and a mapping. Refuse and say why.
            raise ValueError(
                f"Cannot set {path!r}: {part!r} already holds a value, "
                "not a group of settings."
            )
        container = container.setdefault(part, {})
    container[remaining[-1]] = value
    return document


def unset_path(document: dict, path: str) -> dict:
    """Removes one leaf, in place, if it is there.

    Only the leaf. Containers left empty are kept: an empty `config.init:` is a
    harmless thing to have in a file, whereas pruning ancestors could remove a
    block the user is midway through writing.
    """
    parts = [part for part in path.split(".") if part]
    if not parts:
        return document

    container, consumed = _split_at_existing(document, parts)
    remaining = parts[consumed:]
    key = ".".join(remaining)
    if isinstance(container, dict) and key in container:
        del container[key]
    return document


def describe(overrides: Any) -> dict[str, list[dict]]:
    """Every override in a section, as the settings each one makes.

    Returns:
        `{override name: [{path, value}, ...]}`, in file order.
    """
    if not isinstance(overrides, dict):
        return {}
    return {
        str(name): [
            {"path": path, "value": value} for path, value in flatten(body).items()
        ]
        for name, body in overrides.items()
    }
