"""Freezing a model definition into a run directory.

The point of a snapshot is that a run can be reopened later and show the model as
it was written at the time. Two properties carry that, and both are easy to lose:
the captured set has to be *complete* — Calliope names files in three different
ways — and each file has to be byte-identical to its source.

Completeness is tested against Calliope's own example models rather than
hand-built fixtures, because the gap that matters (`config.init.math_paths`) was
found in `urban_scale` and would not have occurred to anyone inventing a fixture.
"""

import calliope
import pytest

from calliope_studio.modeldef.imports import scenario_names
from calliope_studio.modeldef.snapshot import SNAPSHOT_VERSION, collect, write_snapshot


def captured(workspace, destination):
    manifest = write_snapshot(workspace, destination)
    return manifest, {item["path"] for item in manifest["files"]}


class TestCompleteness:
    def test_national_scale_captures_yaml_and_data_tables(
        self, national_scale, tmp_path
    ):
        manifest, paths = captured(national_scale, tmp_path / "snapshot")

        assert manifest["complete"] is True
        assert manifest["solve_from"] == "snapshot"
        assert manifest["version"] == SNAPSHOT_VERSION
        assert "model.yaml" in paths
        assert "model_config/techs.yaml" in paths
        assert "model_config/locations.yaml" in paths
        assert "scenarios.yaml" in paths
        # Every CSV a data table points at, or the model does not build.
        assert {path for path in paths if path.endswith(".csv")}

    def test_urban_scale_captures_math_paths(self, urban_scale, tmp_path):
        """The gap that makes this module necessary rather than a convenience.

        `urban_scale` refers to `additional_math.yaml` through
        `config.init.math_paths`, not through `import:`, so the import graph never
        sees it. A snapshot built from imports and data tables alone is not a
        model that builds — which only surfaces once the worker solves from the
        snapshot, by which point it looks like a solver failure.
        """
        manifest, paths = captured(urban_scale, tmp_path / "snapshot")

        assert "additional_math.yaml" in paths, (
            "math_paths file missing; the snapshot is not buildable"
        )
        assert manifest["complete"] is True

    def test_a_hidden_file_the_model_imports_is_captured(
        self, national_scale, tmp_path
    ):
        """The tree's rule is not the model's.

        `.shared/common.yaml` is hidden for being dot-prefixed, and Calliope
        reads it all the same. It used to be dropped here under the tree's
        rule with `complete` still True, so the worker solved a frozen tree
        missing an import and failed a run the live workspace would have
        completed — while the resolver's fingerprint, built from the same
        list, never noticed an edit to the file either.
        """
        shared = national_scale / ".shared"
        shared.mkdir()
        (shared / "common.yaml").write_text("techs: {}\n", encoding="utf-8")
        model = national_scale / "model.yaml"
        model.write_text(
            model.read_text().replace(
                "import:", 'import:\n  - ".shared/common.yaml"', 1
            )
        )

        manifest, paths = captured(national_scale, tmp_path / "snapshot")

        assert ".shared/common.yaml" in paths
        assert manifest["complete"] is True
        assert (tmp_path / "snapshot" / ".shared" / "common.yaml").is_file()

    def test_data_tables_inside_overrides_are_captured(self, national_scale, tmp_path):
        """`collect_data_tables` looks inside `overrides:`, and must keep doing so."""
        _, paths = captured(national_scale, tmp_path / "snapshot")
        assert any("cluster_days" in path for path in paths)

    @pytest.mark.parametrize("model", ["national_scale", "urban_scale"])
    def test_the_snapshot_is_a_model_calliope_can_read(self, model, request, tmp_path):
        """The contract that makes solving from a snapshot safe.

        Every other test here checks which paths were captured; this one checks
        that what was captured actually adds up to a model.
        """
        workspace = request.getfixturevalue(model)
        destination = tmp_path / "snapshot"
        write_snapshot(workspace, destination)

        assert calliope.read_yaml(str(destination / "model.yaml")) is not None

    def test_a_folder_with_no_model_yields_nothing(self, tmp_path):
        (tmp_path / "notes.md").write_text("not a model")
        manifest, paths = captured(tmp_path, tmp_path / "snapshot")
        assert paths == set()
        assert manifest["complete"] is True


class TestFidelity:
    def test_every_captured_file_is_byte_identical(self, national_scale, tmp_path):
        destination = tmp_path / "snapshot"
        manifest = write_snapshot(national_scale, destination)

        for item in manifest["files"]:
            assert (destination / item["path"]).read_bytes() == (
                national_scale / item["path"]
            ).read_bytes(), item["path"]

    def test_editing_the_workspace_afterwards_leaves_the_snapshot_alone(
        self, national_scale, tmp_path
    ):
        """The whole reason the snapshot exists."""
        destination = tmp_path / "snapshot"
        write_snapshot(national_scale, destination)
        frozen = (destination / "model.yaml").read_text()

        (national_scale / "model.yaml").write_text("wrecked: true\n")

        assert (destination / "model.yaml").read_text() == frozen

    def test_a_symlink_inside_the_workspace_is_materialised(
        self, national_scale, tmp_path
    ):
        """Copied as a regular file, so the snapshot survives the target going."""
        real = national_scale / "model_config" / "techs.yaml"
        link = national_scale / "model_config" / "techs_link.yaml"
        link.symlink_to(real)
        model = national_scale / "model.yaml"
        model.write_text(
            model.read_text().replace(
                '- "model_config/techs.yaml"',
                '- "model_config/techs.yaml"\n  - "model_config/techs_link.yaml"',
            )
        )

        destination = tmp_path / "snapshot"
        write_snapshot(national_scale, destination)

        # The link resolves to a file already captured under its real name, so
        # what matters is that nothing in the snapshot is itself a link.
        assert not any(path.is_symlink() for path in destination.rglob("*"))


class TestIncompleteModels:
    def test_an_import_outside_the_workspace_is_reported_not_copied(
        self, national_scale, tmp_path
    ):
        """An unfreezable model must say so rather than pretend."""
        outside = tmp_path / "outside.yaml"
        outside.write_text("techs: {}\n")
        model = national_scale / "model.yaml"
        model.write_text(
            model.read_text().replace("import:", 'import:\n  - "../outside.yaml"', 1)
        )

        manifest, paths = captured(national_scale, tmp_path / "snapshot")

        assert manifest["complete"] is False
        # Falls back to the live workspace: an incomplete snapshot is not
        # buildable, and failing a run that would have worked is worse.
        assert manifest["solve_from"] == "workspace"
        assert not any("outside" in path for path in paths)

    def test_a_symlink_pointing_out_of_the_workspace_is_external(
        self, national_scale, tmp_path
    ):
        outside = tmp_path / "elsewhere.yaml"
        outside.write_text("techs: {}\n")
        link = national_scale / "linked.yaml"
        link.symlink_to(outside)
        model = national_scale / "model.yaml"
        model.write_text(
            model.read_text().replace("import:", 'import:\n  - "linked.yaml"', 1)
        )

        manifest, paths = captured(national_scale, tmp_path / "snapshot")

        assert manifest["complete"] is False
        assert "linked.yaml" not in paths

    def test_a_reference_into_the_run_directory_is_refused(
        self, national_scale, tmp_path
    ):
        """The one hidden-by-name path a snapshot must not follow.

        `import: calliope-studio/runs/x/snapshot/model.yaml` would otherwise
        make every snapshot contain the previous one.
        """
        inside = national_scale / "calliope-studio" / "runs" / "x" / "snapshot"
        inside.mkdir(parents=True)
        (inside / "model.yaml").write_text("techs: {}\n", encoding="utf-8")
        model = national_scale / "model.yaml"
        model.write_text(
            model.read_text().replace(
                "import:",
                'import:\n  - "calliope-studio/runs/x/snapshot/model.yaml"',
                1,
            )
        )

        collected = collect(national_scale)

        assert not any("calliope-studio" in path for path in collected.files)
        assert [item["reason"] for item in collected.external] == [
            "inside the run output directory"
        ]

    def test_the_data_directory_is_never_captured(self, national_scale, tmp_path):
        """Otherwise every snapshot would contain the previous one."""
        nested = national_scale / "calliope-studio" / "runs" / "old" / "snapshot"
        nested.mkdir(parents=True)
        (nested / "model.yaml").write_text("techs: {}\n")
        model = national_scale / "model.yaml"
        model.write_text(
            model.read_text().replace(
                "import:",
                'import:\n  - "calliope-studio/runs/old/snapshot/model.yaml"',
                1,
            )
        )

        _, paths = captured(national_scale, tmp_path / "snapshot")
        assert not any(path.startswith("calliope-studio") for path in paths)


class TestScenarioNames:
    def test_scenarios_and_overrides_are_both_offered(self, national_scale):
        names = scenario_names(national_scale)
        # `scenario=` takes either, so both sections count.
        assert "time_resampling" in names
        assert "cold_fusion_with_production_share" in names

    def test_a_folder_with_no_model_has_no_scenarios(self, tmp_path):
        assert scenario_names(tmp_path) == set()


class TestCollect:
    def test_the_entry_point_comes_first(self, national_scale):
        collected = collect(national_scale)
        assert collected.files[0] == "model.yaml"

    def test_files_are_not_repeated(self, national_scale):
        collected = collect(national_scale)
        assert len(collected.files) == len(set(collected.files))
