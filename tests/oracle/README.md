# The v0.2.0 data layer, frozen

These five files are the data layer of calligraph v0.2.0, the Panel-based
results viewer, copied here **verbatim**. They are not part of the package and
are never imported by it. `tests/test_oracle.py` materialises them under a
private package name and compares their output, on real solved models, against
what `calliope_studio.results` produces.

They exist because the results layer was reimplemented rather than ported, so
"it looks right" is not evidence. v0.2.0 is a working implementation whose
output was checked against real models for months.

## Provenance

| | |
|---|---|
| Upstream | `calliope-project/calligraph` |
| Tag | `v0.2.0` (commit `1832bed`) |
| Source | `src/calligraph/data/{__init__,colors,variables,query,model}.py` |

The files are byte-identical to the tag. While this checkout still has the tag,
that is checkable directly:

```bash
for m in __init__ colors variables query model; do
  git show "v0.2.0:src/calligraph/data/$m.py" | diff - "tests/oracle/$m.py" \
    && echo "$m ok"
done
```

After the repository is split and the pre-pivot history is gone, the same check
needs a clone of the upstream repository.

## Rules

**Do not edit these files, and do not reformat them.** Their whole value is
being what was tagged. `tests/oracle/` is excluded from ruff in
`pyproject.toml` — `extend-exclude` plus `force-exclude`, which covers
`ruff format` as well as `ruff check` — for exactly that reason: a stray
`pixi run format` would otherwise break the provenance claim above without
changing any behaviour.

Their internal `calligraph.data` imports are left alone too. The test fixture
rewrites that prefix to a private package name when it copies them to a temp
directory, which is the only modification ever applied and is applied at
runtime.

`geo.py` is deliberately not here: the new implementation dropped the Web
Mercator projection that only Bokeh needed, so there is nothing to compare, and
it was the only module that required `pyproj`.
