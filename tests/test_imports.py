"""The import graph: every file the model names, and what names it.

Calliope names files three ways and only one of them is an `import:` chain, so a
graph built from imports alone is a picture of a third of the model. These pin
the other two — `config.init.math_paths` and `data_tables[*].table` — and the
precedence that decides what a file reached both ways is called.
"""

from pathlib import Path

from calliope_studio.modeldef.imports import import_graph


def _nodes(graph: dict) -> dict[str, dict]:
    return {node["id"]: node for node in graph["nodes"]}


def _edges(graph: dict) -> set[tuple[str, str, str]]:
    return {(e["source"], e["target"], e["kind"]) for e in graph["edges"]}


class TestImportGraph:
    def test_math_files_appear_that_the_import_chain_cannot_see(
        self, urban_scale: Path
    ):
        """`additional_math.yaml` is reached only through `config.init.math_paths`.

        Nothing imports it, so a graph built from `import:` alone leaves out a
        file that changes what the optimisation *is* — and the tab that would
        have said so is the one the user opens to find out.
        """
        graph = import_graph(urban_scale)
        assert _nodes(graph)["additional_math.yaml"]["type"] == "math"
        assert ("model.yaml", "additional_math.yaml", "math") in _edges(graph)

    def test_data_tables_appear_with_the_file_that_names_them(self, urban_scale: Path):
        """A model's real numbers are in its CSVs, not in the YAML above them."""
        nodes = _nodes(graph := import_graph(urban_scale))
        csvs = [id for id, node in nodes.items() if node["type"] == "data_table"]
        assert sorted(csvs) == [
            "data_tables/demand.csv",
            "data_tables/export_power.csv",
            "data_tables/pv_resource.csv",
        ]
        for csv in csvs:
            assert ("model.yaml", csv, "data_table") in _edges(graph)

    def test_a_table_declared_inside_an_override_is_shown(self, national_scale: Path):
        """The graph takes `collect_data_tables`' superset, not `active_tables`.

        `cluster_days.csv` belongs to `overrides.time_clustering` in
        `scenarios.yaml`, so it contributes nothing to the base model — but it is
        a file of this model, a run can select it, and a snapshot freezes it.
        """
        graph = import_graph(national_scale)
        assert _nodes(graph)["data_tables/cluster_days.csv"]["type"] == "data_table"
        assert (
            "scenarios.yaml",
            "data_tables/cluster_days.csv",
            "data_table",
        ) in _edges(graph)

    def test_one_csv_named_twice_is_one_edge(self, national_scale: Path):
        """Two edges between one pair draw the same line twice.

        `collect_data_tables` reads under `overrides:` as well as at the top
        level, so a table redeclared in an override names the same CSV again.
        """
        scenarios = national_scale / "scenarios.yaml"
        scenarios.write_text(
            scenarios.read_text(encoding="utf-8")
            + "\n  a_second_override:\n"
            + "    data_tables.costs.table: data_tables/costs.csv\n",
            encoding="utf-8",
        )
        edges = import_graph(national_scale)["edges"]
        pairs = [(e["source"], e["target"]) for e in edges]
        assert len(pairs) == len(set(pairs))

    def test_a_file_both_imported_and_math_is_math(self, tmp_path: Path):
        """What a file *is* beats how it was reached, whichever order it is met in.

        Typing it by first arrival would make the answer depend on the order of
        the walk, so both spellings are asserted. `filekinds.classify` resolves
        the same collision the same way.
        """
        for name in ("extra.yaml", "zzz.yaml"):
            workspace = tmp_path / name
            workspace.mkdir()
            (workspace / name).write_text("variables: {}\n", encoding="utf-8")
            (workspace / "model.yaml").write_text(
                f"import:\n  - {name}\n"
                f"config:\n  init:\n    math_paths:\n      mine: {name}\n",
                encoding="utf-8",
            )
            assert _nodes(import_graph(workspace))[name]["type"] == "math"

    def test_a_missing_reference_is_shown_rather_than_dropped(
        self, national_scale: Path
    ):
        """A typo in a `table:` path is otherwise silent until a run fails on it."""
        model = national_scale / "model.yaml"
        model.write_text(
            model.read_text(encoding="utf-8").replace(
                "data_tables/costs.csv", "data_tables/nope.csv"
            ),
            encoding="utf-8",
        )
        missing = [
            node
            for node in import_graph(national_scale)["nodes"]
            if node["type"] == "missing"
        ]
        assert [node["label"] for node in missing] == ["data_tables/nope.csv"]
        assert missing[0]["reason"] == "not found"

    def test_a_reference_outside_the_workspace_says_so(self, tmp_path: Path):
        """Distinct from "not found": no edit inside the folder fixes it.

        The file exists, so only the *reason* tells the two apart — and it is the
        one a snapshot cannot freeze, which is why `write_snapshot` downgrades a
        model carrying one to solving from the live workspace.
        """
        (tmp_path / "elsewhere.yaml").write_text("{}\n", encoding="utf-8")
        workspace = tmp_path / "model"
        workspace.mkdir()
        (workspace / "model.yaml").write_text(
            "import:\n  - ../elsewhere.yaml\n", encoding="utf-8"
        )
        missing = [
            node
            for node in import_graph(workspace)["nodes"]
            if node["type"] == "missing"
        ]
        assert [node["reason"] for node in missing] == ["outside the workspace"]
        assert [node["label"] for node in missing] == ["../elsewhere.yaml"]

    def test_the_entry_point_is_the_only_root(self, urban_scale: Path):
        """Nothing else may take the accent, however it is named elsewhere."""
        graph = import_graph(urban_scale)
        roots = [node["id"] for node in graph["nodes"] if node["type"] == "root"]
        assert roots == ["model.yaml"]

    def test_a_folder_with_no_model_yaml_is_empty(self, tmp_path: Path):
        """Not an error: it is what the browser shows for any other directory."""
        assert import_graph(tmp_path) == {"nodes": [], "edges": []}
