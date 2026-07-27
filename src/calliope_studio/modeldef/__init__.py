"""Reading and writing Calliope model definitions on disk.

A model definition is a folder of YAML files (with `import:` chains, templates,
overrides and scenarios) plus CSV data tables. This layer manipulates those
files *without losing formatting*:

- `yaml_io` — comment-preserving round-trip via `ruamel.yaml` (`typ="rt"`), and
  the section-level read/modify/write that the structured editors are built on.
  This is the load-bearing primitive of the editor; it stays in Python.
- `imports` — the `import:` graph and the conceptual component tree across it.
- `data_tables` — which parameters come from CSV data tables, and whether each
  is a scalar or time-varying, inferred with pandas.
- `paths` — workspace-relative path resolution with traversal guards.
- `validate` — YAML syntax checking (structural validation against Calliope's
  schemas happens in the frontend; semantic validation happens in `runs`).

No web-framework imports.
"""

__all__: list[str] = []
