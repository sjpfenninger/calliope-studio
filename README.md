# Calliope Studio

`Calliope Studio` is a web-based user interface for [Calliope](https://calliope.readthedocs.io/) energy system models. It covers the whole loop — **define → validate → run → analyse** — in a browser, and runs on your own machine: you start it from a terminal, it opens a tab, and nothing leaves your computer.

## Install

You need a way to install Python packages. If you have none, take the first route; if you already use conda, mamba or pixi, take the second.

**With [uv](https://docs.astral.sh/uv/), which brings its own Python:**

```shell
# macOS and Linux
curl -LsSf https://astral.sh/uv/install.sh | sh
# Windows
#   powershell -c "irm https://astral.sh/uv/install.ps1 | iex"

uv tool install calliope-studio
```

**With conda-forge, which brings a solver with it:**

```shell
pixi global install calliope-studio
# or: conda install -c conda-forge calliope-studio
```

Then, either way:

```shell
calliope-studio my-model      # a model folder, or a solved results .nc
calliope-studio               # no argument: pick from a list, or make a new one
```

It prints a URL and opens your browser at it. To stop it, close the terminal window or press Ctrl+C.

> [!IMPORTANT]
> **The uv route installs no solver.** Calliope needs one to actually optimise a
> model, and the default — CBC — is not installable from PyPI by anybody.
>
> Without one you can still do most of what Studio is for: write and edit a
> model, validate it, browse its math, and open and analyse results somebody
> else solved. Pressing **Run** will fail.
>
> Two fixes: `conda install -c conda-forge coin-or-cbc` alongside, or use the
> conda-forge route above, which brings CBC as an ordinary dependency. Studio
> tells you which solvers it can reach — the `solver` field in the config editor
> offers exactly the ones that are actually installed.

## Making a model to open

Calliope's own command creates one from a template:

```shell
calliope new my-model --template national_scale
calliope-studio my-model
```

Or press **New model** on the picker, which does the same thing without a terminal.

## Using Gurobi

Gurobi is not on conda-forge; it ships from its own channel and needs a licence. With `gurobipy` installed and licensed, set `config.solve.solver: gurobi` in your model. Calliope's native `gurobi` backend (`config.build.backend: gurobi`) also works and is usually faster to build.

## If something goes wrong

**"Run" fails with a solver error.** See the note above: you probably have no solver installed. The config editor's `solver` field lists the ones this machine can reach.

**The port is in use.** Studio scans upward from 8000 and tells you which port it took. `--port 9000` picks a different starting point.

**It opened the wrong model, or the list is wrong.** The list of models you have opened lives in a small registry file, separate from the models themselves. Its location is reported as `registry_path` by `http://127.0.0.1:8000/api/health`; deleting it resets the list and touches none of your models.

**Where results go.** Beside the model, in a visible `calliope-studio/` folder — visible because results are the valuable output and a hidden folder is one you cannot find, open or share. It is created the first time you actually run something, and it ignores itself in git.

## Development

Requires [pixi](https://pixi.sh/).

```shell
pixi run serve      # API only, on :8000, with reload
pixi run web-dev    # Vite dev server, proxying /api to :8000
pixi run test       # the Python suite
```

`pixi run build` produces a wheel and an sdist with the frontend compiled in.

## Licence

AGPL-3.0-or-later. See [LICENSE](LICENSE).
