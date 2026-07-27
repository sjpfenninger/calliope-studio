"""Reading solved Calliope models and shaping results for the frontend.

This layer owns everything between a `.nc` file and the bytes that go over the
wire to a chart:

- opening and caching solved models (`store`)
- categorising variables and computing synthetic ones such as `flow*` (`catalog`)
- applying selectors, time ranges, resampling and aggregation (`query`)
- deterministic technology colours (`colors`)
- node/link geometry as GeoJSON (`geo`)
- model and config summaries (`summaries`)
- serialising a result set as a wide-by-series Arrow IPC stream (`arrow`)

It has no web-framework dependency and returns plain Python, pandas and Arrow
objects, so it is equally usable from a notebook.

Much of the logic here is a reimplementation of `calligraph.data` as it stood at
v0.2.0, before this project was renamed. That code is the reference and the
numerical oracle, and it is vendored verbatim at `tests/oracle/` — read it there
rather than out of git: this repository's history begins at the pivot and does
not contain it.
"""

__all__: list[str] = []
