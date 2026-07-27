"""Building and solving Calliope models.

Runs happen in a **separate process**, always. Calliope exposes no interrupt
API — no timeout, no solver callback, no `KeyboardInterrupt` handling — so
killing the process is the only way to cancel a run, and process isolation is
also what keeps a solver crash from taking the server down.

- `protocol` — the files a run is made of, and the event format the worker and
  its parent share. `events.jsonl` is the run's whole account of itself.
- `worker` — the child process: `read_yaml` → `build` → `solve` → `to_netcdf`.
  Progress and log output reach `events.jsonl` through a `logging.Handler` on
  the `calliope` logger, and through a file-descriptor capture of stdout and
  stderr — which is what makes Gurobi's output, written from C straight to fd 1,
  visible at all.
- `stages` — where a run has got to, read off the comments Calliope logs as it
  passes its own stage boundaries, so the UI can show real stages rather than a
  log tail.
- `validate` — the two cheap tiers that need no solver: `read_yaml` alone is a
  full definition and config validation pass, and `build()` without `solve()`
  additionally validates the math.
- `manager` — the parent side: starting, watching, cancelling. A run's state is
  derived from its directory rather than held in memory, so a server restart
  loses nothing.

Writing `results.nc` is what connects this layer to `calliope_studio.results`.
"""

__all__: list[str] = []
