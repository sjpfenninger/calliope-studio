"""Building and solving Calliope models.

Runs happen in a **separate process**, always. Calliope exposes no interrupt
API — no timeout, no solver callback, no `KeyboardInterrupt` handling — so
killing the process is the only way to cancel a run, and process isolation is
also what keeps a solver crash from taking the server down.

- `worker` — the child process: `read_yaml` → `build` → `solve` → `to_netcdf`.
  Progress is reported by attaching a `logging.QueueHandler` to the `calliope`
  logger; solver output arrives on `calliope.backend.backend_model.<solve>` at
  DEBUG, so CBC/Gurobi iteration lines stream live.
- `stages` — structured progress derived from `model.runtime.timings`
  (`preprocess_start`, `build_start`, `solve_start`, `solver_exit`, ...), so the
  UI can show real stages rather than a log tail.
- `validate` — the two cheap tiers that need no solver: `read_yaml` alone is a
  full definition and config validation pass, and `build()` without `solve()`
  additionally validates the math.
- `artifacts` — run outputs under `runs/{id}/`: `results.nc` and `run.log`.

Writing `results.nc` is what connects this layer to `calliope_studio.results`.
"""

__all__: list[str] = []
