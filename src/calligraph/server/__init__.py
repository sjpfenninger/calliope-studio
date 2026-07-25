"""The FastAPI application.

This is the only layer that imports `fastapi` and the only one that knows about
HTTP. It is a thin adapter over `calligraph.modeldef`, `calligraph.runs` and
`calligraph.results` — route handlers should contain routing, validation and
serialisation, and no domain logic.

Three seams keep the local and hosted deployments from forking into two
codebases. Only the local side of each is implemented for now:

- **storage** — a user-chosen folder on disk vs. a server-managed workspace
- **auth** — none (localhost) vs. per-user tokens
- **task queue** — an in-process subprocess vs. a broker-backed worker

Route handlers depend on the interface, never on the concrete implementation.

The server never emits figures. Results go out as Arrow IPC streams and the
frontend builds the charts.
"""

__all__: list[str] = []
