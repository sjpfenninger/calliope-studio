"""Turning a reduced array into wide-by-series Arrow record batches.

The v0.2.0 layer returned tidy *long* frames — `nodes, techs, carriers,
timesteps, value` — because that is the shape Plotly Express consumes. Nothing
consumes that shape now, and it is a poor thing to put on a wire: every row
repeats its dimension labels as strings, so one unresampled hourly variable on a
small model is a few hundred thousand rows of mostly redundant text.

Wide-by-series instead: one index column, then one float column per chart
series, with the dimension coordinates that identify the series carried in the
Arrow field's metadata rather than in the data. A chart reads each column
straight out as a typed array, with no parsing and no grouping pass.
"""

import io
import json
from typing import Iterator

import numpy as np
import pandas as pd
import pyarrow as pa
import xarray as xr

from calliope_studio.results.query import Query, choose_index

#: Rows per record batch. Small enough that the first batch paints quickly,
#: large enough that the per-batch overhead stays irrelevant.
BATCH_ROWS = 4096

#: Separator between dimension values in a series key. Chosen because Calliope
#: identifiers do not contain it.
SERIES_SEPARATOR = " | "


def series_key(coordinates: dict[str, str]) -> str:
    """A stable, human-readable name for one series."""
    return (
        SERIES_SEPARATOR.join(str(value) for value in coordinates.values()) or "value"
    )


def _to_wide(array: xr.DataArray, index: str | None) -> tuple[pd.DataFrame, list[str]]:
    """Reshapes to a frame indexed by `index`, one column per series."""
    if index is None:
        # A fully reduced scalar still has to be renderable.
        return pd.DataFrame({"value": [float(array.values)]}, index=[0]), []

    series_dims = [str(dim) for dim in array.dims if dim != index]
    frame = array.to_dataframe(name="value").reset_index()

    if not series_dims:
        wide = frame.set_index(index)[["value"]]
        return wide, []

    wide = frame.pivot_table(
        index=index, columns=series_dims, values="value", dropna=False
    )
    return wide, series_dims


def _drop_empty(wide: pd.DataFrame) -> pd.DataFrame:
    """Removes series with nothing to show.

    A model defines every variable over the full cross product of its
    dimensions, so most combinations are empty; sending them would fill a legend
    with entries that draw nothing.
    """
    keep = [
        column
        for column in wide.columns
        if wide[column].notna().any() and (wide[column].fillna(0) != 0).any()
    ]
    return wide[keep]


def _apply_duration_order(wide: pd.DataFrame) -> pd.DataFrame:
    """Sorts every series independently, descending.

    This is the load-duration curve: the index stops being time and becomes a
    count of periods, so each column is sorted on its own rather than the frame
    being sorted as a whole.
    """
    ordered = {
        column: wide[column].dropna().sort_values(ascending=False).to_numpy()
        for column in wide.columns
    }
    height = max((len(values) for values in ordered.values()), default=0)
    padded = {
        column: np.append(values, np.full(height - len(values), np.nan))
        for column, values in ordered.items()
    }
    return pd.DataFrame(padded, index=pd.RangeIndex(height, name="period"))


def _field_metadata(
    column, series_dims: list[str], colors: dict[str, str], unit: str | None
) -> dict[bytes, bytes]:
    values = column if isinstance(column, tuple) else (column,)
    coordinates = {dim: str(value) for dim, value in zip(series_dims, values)}
    metadata = {b"dims": json.dumps(coordinates).encode()}
    # Colour is keyed on technology, which is what a legend is almost always
    # grouped by; anything else simply has no colour of its own.
    tech = coordinates.get("techs")
    if tech and tech in colors:
        metadata[b"color"] = colors[tech].encode()
    if unit:
        metadata[b"unit"] = unit.encode()
    return metadata


def build_table(
    array: xr.DataArray,
    query: Query,
    colors: dict[str, str] | None = None,
    unit: str | None = None,
) -> pa.Table:
    """Builds the Arrow table for a reduced array.

    Returns:
        A table whose first column is the index and whose remaining columns are
        one series each, carrying their identifying coordinates as field
        metadata.
    """
    colors = colors or {}
    index = choose_index(array, query.index)
    wide, series_dims = _to_wide(array, index)

    if query.drop_zeros and len(wide.columns) > 1:
        wide = _drop_empty(wide)

    if query.order == "duration":
        wide = _apply_duration_order(wide)
        index = "period"

    wide = wide.sort_index()

    index_values = wide.index.to_numpy()
    arrays = [pa.array(index_values)]
    fields = [pa.field(str(index or "index"), arrays[0].type)]

    for column in wide.columns:
        values = pa.array(wide[column].to_numpy(dtype="float64"), type=pa.float64())
        name = series_key(
            {dim: value for dim, value in zip(series_dims, _as_tuple(column))}
        )
        arrays.append(values)
        fields.append(
            pa.field(
                name,
                pa.float64(),
                metadata=_field_metadata(column, series_dims, colors, unit),
            )
        )

    metadata = {
        b"variable": query.variable.encode(),
        b"index": str(index or "index").encode(),
        b"order": query.order.encode(),
        b"series_dims": json.dumps(series_dims).encode(),
    }
    # One variable per frame means one unit for the whole of it, so the schema is
    # where a reader should look. It is stamped per field as well because that is
    # what makes a single column self-describing to anything reading the stream
    # outside this app — one value, written twice, not two answers.
    if unit:
        metadata[b"unit"] = unit.encode()

    schema = pa.schema(fields, metadata=metadata)
    return pa.Table.from_arrays(arrays, schema=schema)


def _as_tuple(column) -> tuple:
    return column if isinstance(column, tuple) else (column,)


class _DrainableSink(io.RawIOBase):
    """A sink whose written bytes can be taken out as they accumulate.

    `pa.BufferOutputStream` cannot be used for this: reading its value closes
    it, so the writer cannot continue afterwards.
    """

    def __init__(self) -> None:
        self._chunks: list[bytes] = []

    def writable(self) -> bool:
        return True

    def write(self, data) -> int:  # noqa: D102 - file protocol
        payload = bytes(data)
        self._chunks.append(payload)
        return len(payload)

    def drain(self) -> bytes:
        payload = b"".join(self._chunks)
        self._chunks.clear()
        return payload


def stream_ipc(table: pa.Table, batch_rows: int = BATCH_ROWS) -> Iterator[bytes]:
    """Serialises a table as an Arrow IPC stream, one chunk at a time.

    Yielding as batches are written, rather than one buffer at the end, lets a
    chart paint as soon as the first arrives — which is what makes a long
    timeseries feel responsive rather than merely fast.
    """
    sink = _DrainableSink()
    with pa.ipc.new_stream(sink, table.schema) as writer:
        # The schema is written on construction; send it before any data so the
        # client can set up its columns immediately.
        if payload := sink.drain():
            yield payload

        for batch in table.to_batches(max_chunksize=batch_rows):
            writer.write_batch(batch)
            if payload := sink.drain():
                yield payload

    # The end-of-stream marker is written on close.
    if payload := sink.drain():
        yield payload
