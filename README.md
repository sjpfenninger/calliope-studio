[![PyPI](https://img.shields.io/pypi/v/calliope-studio?label=pypi&style=flat-square)](https://pypi.org/project/calliope-studio/)
[![conda-forge](https://img.shields.io/conda/vn/conda-forge/calliope-studio?label=conda-forge&style=flat-square)](https://anaconda.org/conda-forge/calliope-studio)
[![Tests](https://img.shields.io/github/actions/workflow/status/sjpfenninger/calliope-studio/ci.yml?branch=main&label=tests&style=flat-square)](https://github.com/sjpfenninger/calliope-studio/actions/workflows/ci.yml)
[![Python coverage](https://img.shields.io/codecov/c/github/sjpfenninger/calliope-studio?flag=python&label=python%20coverage&style=flat-square)](https://app.codecov.io/gh/sjpfenninger/calliope-studio?flags%5B0%5D=python)
[![Web coverage](https://img.shields.io/codecov/c/github/sjpfenninger/calliope-studio?flag=web&label=web%20coverage&style=flat-square)](https://app.codecov.io/gh/sjpfenninger/calliope-studio?flags%5B0%5D=web)

# Calliope Studio

`Calliope Studio` is a web-based user interface for the [Calliope](https://calliope.readthedocs.io/) energy system modelling framework.
It lets you define, edit, validate, run, and analyse Calliope models, all in a single tool.
It runs in a browser directly on your computer.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://calliope-studio-shots.pages.dev/showcase-dark.png">
  <img alt="The results view on an example model."
       src="https://calliope-studio-shots.pages.dev/showcase-light.png">
</picture>

## Installation

With [uv](https://docs.astral.sh/uv/):

```shell
# One-time setup for uv on macOS and Linux
curl -LsSf https://astral.sh/uv/install.sh | sh
# One-time setup for uv on Windows
#   powershell -c "irm https://astral.sh/uv/install.ps1 | iex"

uv tool install calliope-studio
```

Or with [conda](https://docs.conda.io/)/[mamba](https://mamba.readthedocs.io/):

```shell
conda create -n calliope-studio -c conda-forge calliope-studio
conda activate calliope-studio
```

Then:

```shell
calliope-studio my-model      # a model folder containing model.yaml or a solved results .nc
calliope-studio               # no argument opens Calliope Studio with a model picker
```

To quit Calliope Studio, close its terminal window or press Ctrl+C inside it.

### Development builds

To install a development build based on the latest `main` branch commit:

```shell
uv tool install --reinstall --prerelease allow \
  --find-links https://github.com/sjpfenninger/calliope-studio/releases/expanded_assets/dev \
  calliope-studio
```

The same command updates an existing install to the newest development build. To go back to the stable (released) version:

```shell
uv tool install --reinstall calliope-studio
```

## FAQ

- **Why does "Run" fail with a solver error?** Calliope needs a solver to run a model. Calliope 0.7 bundles the HiGHS solver, but some models may refer to other solvers such as CBC or Gurobi. Refer to the [Calliope documentation for the different solver options](https://calliope.readthedocs.io/en/stable/installation/#choosing-a-solver).
- **Why is the list of models wrong or outdated?** The list of models you have opened lives in a small registry file, separate from the models themselves. Its location is reported as `registry_path` by `http://127.0.0.1:8000/api/health` while Calliope Studio is running. Deleting it resets the list without actually touching any of your models.
- **Where are model results stored?** When running a model from inside Calliope Studio, results are saved in a `calliope-studio/` folder next to the `model.yaml` file. This folder is created automatically when running a model for the first time and comes with its own `.gitignore` file.

## Development

Requires [pixi](https://pixi.sh/). Try `pixi task list` to see all the available development tasks.

```shell
pixi run serve      # API on port 8000 with auto-reload
pixi run web-dev    # Vite dev server, proxying /api to port 8000
```

`serve` opens `./example-model`, scaffolding it from Calliope's `national_scale` template on first use.

The frontend tests run from `web/`:

```shell
cd web
pnpm test
```

Pixi is configured with a `gurobi` environment to test with Gurobi (needs a license):

```shell
pixi run -e gurobi calliope-studio my-model   # Gurobi available as a solver
```

## Architecture

The frontend is a [Vue 3](https://vuejs.org/) single-page TypeScript app served by a [FastAPI](https://fastapi.tiangolo.com/) backend.

The backend consists of four Python packages with a one-way import rule: `server` may import the others, while they import neither `server` nor each other:

- `server`: FastAPI app and HTTP routes
- `modeldef`: YAML and CSV model definitions on disk
- `runs`: Builds and solves models in a separate process
- `results`: Reads `.nc` files and streams them as [Apache Arrow](https://arrow.apache.org/) batches for charts and tables

## License

AGPL-3.0-or-later. See [LICENSE](https://github.com/sjpfenninger/calliope-studio/blob/main/LICENSE).
