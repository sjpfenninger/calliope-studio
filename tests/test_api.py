"""The HTTP surface.

URL shapes are inherited from the prototype the frontend came from, so these
also serve as a contract test: if a path or payload here changes, the Vue app
breaks.
"""

import pytest

from calliope_studio.server import deps


@pytest.fixture
def ws(client):
    """The workspace id the test client has open."""
    return client.workspace_id


class TestHealth:
    def test_reports_the_open_workspace(self, client, national_scale):
        body = client.get("/api/health").json()
        assert body["status"] == "ok"
        assert body["workspace"] == str(national_scale)
        assert body["workspace_id"]

    def test_unmatched_api_paths_do_not_fall_through_to_the_spa(self, client):
        """A withdrawn or mistyped endpoint must fail loudly, not return HTML."""
        response = client.get("/api/does-not-exist")
        assert response.status_code == 404
        assert "text/html" not in response.headers.get("content-type", "")


class TestProjects:
    def test_opened_folder_appears_as_a_project(self, client, ws):
        projects = client.get("/api/projects/").json()
        assert [p["id"] for p in projects] == [ws]

    def test_project_detail(self, client, ws, national_scale):
        body = client.get(f"/api/projects/{ws}/").json()
        assert body["name"] == national_scale.name

    def test_unknown_project_is_404(self, client):
        assert client.get("/api/projects/deadbeef/").status_code == 404

    def test_a_workspace_has_one_version_sharing_its_id(self, client, ws):
        versions = client.get(f"/api/projects/{ws}/versions/").json()
        assert [v["id"] for v in versions] == [ws]

    def test_opening_a_folder_registers_it(self, client, urban_scale):
        body = client.post("/api/projects/", json={"path": str(urban_scale)})
        assert body.status_code == 201
        assert body.json()["name"] == "urban_scale"
        assert len(client.get("/api/projects/").json()) == 2

    def test_opening_a_non_directory_is_rejected(self, client, national_scale):
        response = client.post(
            "/api/projects/", json={"path": str(national_scale / "model.yaml")}
        )
        assert response.status_code == 400

    def test_opening_a_folder_without_a_model_is_rejected(self, client, tmp_path):
        empty = tmp_path / "empty"
        empty.mkdir()
        response = client.post("/api/projects/", json={"path": str(empty)})
        assert response.status_code == 400
        assert "calliope new" in response.json()["detail"]
        assert len(client.get("/api/projects/").json()) == 1

    def test_a_model_can_be_removed_from_the_recents_list(
        self, client, urban_scale, national_scale
    ):
        """Leaving the list must not mean deleting the folder.

        Until now an entry could only disappear by the folder being removed from
        disk, which is a wildly disproportionate way of saying "I am not working
        on that any more".
        """
        opened = client.post("/api/projects/", json={"path": str(urban_scale)}).json()

        assert client.delete(f"/api/projects/{opened['id']}/").status_code == 204

        assert [p["id"] for p in client.get("/api/projects/").json()] != [opened["id"]]
        assert (urban_scale / "model.yaml").is_file()

    def test_removing_an_unknown_model_is_404(self, client):
        assert client.delete("/api/projects/deadbeef/").status_code == 404

    def test_health_says_where_the_recents_list_lives(self, client):
        # A list of the user's own folders, kept in an invisible state
        # directory, is otherwise something they can neither find nor reset.
        registry = client.get("/api/health").json()["registry_path"]
        assert registry.endswith("workspaces.json")


class TestNewModel:
    """Creating a model, which used to mean leaving the app for a terminal."""

    @pytest.fixture
    def parent(self, tmp_path):
        """An empty folder to create models in.

        Its own directory rather than `tmp_path`, which already holds the test
        client's state directory and model fixtures — "nothing was written" is
        only checkable somewhere nothing else writes.
        """
        directory = tmp_path / "somewhere"
        directory.mkdir()
        return directory

    def test_templates_are_read_from_calliope(self, client):
        body = client.get("/api/model-templates/").json()
        assert {"national_scale", "urban_scale"} <= set(body["templates"])
        assert body["default"] in body["templates"]

    def test_creating_a_model_registers_it(self, client, parent):
        response = client.post(
            "/api/projects/new/", json={"parent": str(parent), "name": "my-model"}
        )
        assert response.status_code == 201
        created = response.json()
        assert created["name"] == "my-model"
        assert (parent / "my-model" / "model.yaml").is_file()
        assert created["id"] in [p["id"] for p in client.get("/api/projects/").json()]

    def test_the_template_chooses_what_is_copied(self, client, parent):
        client.post(
            "/api/projects/new/",
            json={"parent": str(parent), "name": "urban", "template": "urban_scale"},
        )
        # `additional_math.yaml` is urban_scale's; national_scale has no such file.
        assert (parent / "urban" / "additional_math.yaml").is_file()

    def test_creating_over_an_existing_folder_is_refused(self, client, parent):
        (parent / "taken").mkdir()
        response = client.post(
            "/api/projects/new/", json={"parent": str(parent), "name": "taken"}
        )
        assert response.status_code == 409
        # Refusing rather than merging is the point: a mistyped name must not
        # scatter a template over a model that is already there.
        assert list((parent / "taken").iterdir()) == []

    @pytest.mark.parametrize("name", ["", "  ", "..", "../escape", "a/b", ".hidden"])
    def test_a_name_must_be_a_visible_folder_name(self, client, parent, name):
        response = client.post(
            "/api/projects/new/", json={"parent": str(parent), "name": name}
        )
        assert response.status_code == 400
        assert list(parent.iterdir()) == []

    def test_an_unknown_template_is_rejected(self, client, parent):
        response = client.post(
            "/api/projects/new/",
            json={"parent": str(parent), "name": "m", "template": "nope"},
        )
        assert response.status_code == 400
        assert list(parent.iterdir()) == []

    def test_a_missing_parent_is_rejected(self, client, parent):
        response = client.post(
            "/api/projects/new/", json={"parent": str(parent / "nowhere"), "name": "m"}
        )
        assert response.status_code == 400


class TestFiles:
    def test_file_tree_lists_the_model(self, client, ws):
        entries = client.get(f"/api/versions/{ws}/files/").json()
        paths = {entry["path"] for entry in entries}
        assert "model.yaml" in paths
        assert any(path.endswith(".csv") for path in paths)
        assert {entry["type"] for entry in entries} <= {
            "yaml",
            "csv",
            "markdown",
            "image",
            "binary",
            "other",
            "directory",
        }

    def test_file_tree_lists_directories_in_their_own_right(
        self, client, ws, national_scale
    ):
        """An empty folder must be listable, or it cannot be created.

        The tree the frontend builds used to infer a folder from the `/` in a
        file's path, so a folder with nothing in it did not exist as far as the
        UI was concerned — it would vanish on the next listing.
        """
        (national_scale / "scratch").mkdir()
        entries = client.get(f"/api/versions/{ws}/files/").json()
        directories = {e["path"] for e in entries if e["type"] == "directory"}
        assert "scratch" in directories
        assert "model_config" in directories
        # A directory has no meaningful size, so it carries none.
        assert all("size" not in e for e in entries if e["type"] == "directory")

    @pytest.mark.parametrize(
        "data_dir", ["calliope-studio", "calligraph", ".calligraph"]
    )
    def test_run_outputs_are_hidden_from_the_tree(
        self, client, ws, national_scale, data_dir
    ):
        """Run outputs are visible on disk but not part of the model definition.

        All three names: `calliope-studio` is where they go now, and `calligraph`
        and `.calligraph` are what a workspace may still carry from before the
        rename (and, for the hidden one, from before that) if migration could not
        run.
        """
        (national_scale / data_dir / "runs" / "x").mkdir(parents=True)
        (national_scale / data_dir / "runs" / "x" / "run.log").write_text("noise")
        paths = {e["path"] for e in client.get(f"/api/versions/{ws}/files/").json()}
        assert not any(path.startswith(data_dir) for path in paths)

    def test_read_and_write_round_trip(self, client, ws):
        url = f"/api/versions/{ws}/files/model.yaml"
        original = client.get(url).json()["content"]
        assert "config:" in original

        assert client.put(
            url, json={"content": original + "\n# appended\n"}
        ).json() == {"ok": True}
        assert client.get(url).json()["content"].endswith("# appended\n")

    def test_missing_file_is_404(self, client, ws):
        assert client.get(f"/api/versions/{ws}/files/nope.yaml").status_code == 404

    def test_binary_file_is_refused_rather_than_mangled(
        self, client, ws, national_scale
    ):
        """A binary must not come back as text, however plausible the text.

        `read_text(errors="replace")` could not fail, so a `.png` was HTTP 200
        holding a string of U+FFFD. Monaco opened it, and Ctrl/Cmd+S then wrote
        that transcription back over the file. The read is where it has to stop:
        by the time the editor has a buffer, the damage is one keystroke away.
        """
        (national_scale / "diagram.png").write_bytes(b"\x89PNG\r\n\x1a\n\x00\x00stuff")
        response = client.get(f"/api/versions/{ws}/files/diagram.png")
        assert response.status_code == 415
        assert response.json()["detail"] == "This file is not text."

    def test_a_stray_non_utf8_byte_still_opens(self, client, ws, national_scale):
        """The tolerance `errors="replace"` was chosen for has to survive.

        A YAML file carrying one Latin-1 byte is a file somebody is part-way
        through editing. A strict decode would lock them out of it, which is why
        the binary test is a NUL sniff and not a failed decode.
        """
        (national_scale / "note.yaml").write_bytes(b"comment: caf\xe9\n")
        response = client.get(f"/api/versions/{ws}/files/note.yaml")
        assert response.status_code == 200
        assert "�" in response.json()["content"]

    def test_an_oversized_file_is_refused(
        self, client, ws, national_scale, monkeypatch
    ):
        """Nothing capped the path from a file on disk to `createModel`."""
        monkeypatch.setattr(deps, "MAX_TEXT_BYTES", 16)
        (national_scale / "big.yaml").write_text("x" * 64)
        assert client.get(f"/api/versions/{ws}/files/big.yaml").status_code == 413

    def test_raw_serves_bytes_with_a_conservative_type(
        self, client, ws, national_scale
    ):
        """Only pictures are named; everything else is an opaque download.

        An `.html` in a model folder served as `text/html` from the app's own
        origin would be a script-execution hole, so the route names content
        types from a closed list rather than guessing.
        """
        (national_scale / "diagram.png").write_bytes(b"\x89PNG\r\n\x1a\n\x00\x00stuff")
        (national_scale / "page.html").write_text("<script>alert(1)</script>")

        image = client.get(f"/api/versions/{ws}/raw/diagram.png")
        assert image.status_code == 200
        assert image.headers["content-type"] == "image/png"
        assert image.content.startswith(b"\x89PNG")
        assert image.headers["x-content-type-options"] == "nosniff"
        assert image.headers["content-security-policy"] == "sandbox"

        page = client.get(f"/api/versions/{ws}/raw/page.html")
        assert page.headers["content-type"] == "application/octet-stream"

    def test_create_file_and_folder(self, client, ws, national_scale):
        assert (
            client.post(f"/api/versions/{ws}/files/model_config/extra.yaml").status_code
            == 200
        )
        assert (national_scale / "model_config" / "extra.yaml").read_text() == ""

        assert (
            client.post(f"/api/versions/{ws}/folders/scratch/deep").status_code == 200
        )
        assert (national_scale / "scratch" / "deep").is_dir()

        paths = {e["path"] for e in client.get(f"/api/versions/{ws}/files/").json()}
        assert "model_config/extra.yaml" in paths
        assert "scratch/deep" in paths

    def test_create_refuses_to_overwrite(self, client, ws):
        """`PUT` replaces on purpose; `POST` must not.

        Creating through `PUT` with an empty body would have silently truncated
        whatever was there, and the client validates against a file tree that
        may be seconds out of date.
        """
        response = client.post(f"/api/versions/{ws}/files/model.yaml")
        assert response.status_code == 409

    @pytest.mark.parametrize(
        ("path", "reason"),
        [
            ("calliope-studio/notes.yaml", "hidden from the file tree"),
            (".secret.yaml", "starting with a dot"),
            ("model.yaml/child.yaml", "is a file"),
        ],
    )
    def test_create_refuses_what_could_not_then_be_found(
        self, client, ws, path, reason
    ):
        """Every one of these would appear to succeed and then show nothing."""
        response = client.post(f"/api/versions/{ws}/files/{path}")
        assert response.status_code == 400
        assert reason in response.json()["detail"]

    def test_create_rejects_path_traversal(self, client, ws):
        response = client.post(f"/api/versions/{ws}/folders/%2e%2e%2fescape")
        assert response.status_code == 400
        assert response.json()["detail"] == "Invalid path."

    @pytest.mark.parametrize(
        "attack",
        [
            # Percent-encoded, because an HTTP client collapses a literal `..`
            # out of the URL before it is ever sent. This is the form that
            # actually reaches a handler.
            "%2e%2e%2fescape.yaml",
            "%2e%2e/escape.yaml",
            "..%2fescape.yaml",
            "%2e%2e%2f%2e%2e%2fetc%2fpasswd",
        ],
    )
    def test_path_traversal_is_rejected(self, client, ws, attack):
        response = client.get(f"/api/versions/{ws}/files/{attack}")
        assert response.status_code == 400
        assert response.json()["detail"] == "Invalid path."


class TestCsv:
    def test_read_infers_column_types(self, client, ws):
        body = client.get(f"/api/versions/{ws}/csv/data_tables/costs.csv").json()
        assert body["columns"]
        assert body["rows"]
        assert {column["type"] for column in body["columns"]} <= {"numeric", "text"}

    def test_write_round_trip(self, client, ws):
        url = f"/api/versions/{ws}/csv/data_tables/costs.csv"
        body = client.get(url).json()
        assert client.put(url, json=body).json() == {"ok": True}
        assert client.get(url).json() == body


class TestYamlSections:
    def test_read_a_section(self, client, ws):
        body = client.get(
            f"/api/versions/{ws}/yaml-section/model.yaml", params={"section": "config"}
        ).json()
        assert body["section"] == "config"
        assert "init" in body["data"]

    def test_missing_section_is_404(self, client, ws):
        response = client.get(
            f"/api/versions/{ws}/yaml-section/model.yaml", params={"section": "nope"}
        )
        assert response.status_code == 404

    def test_section_required(self, client, ws):
        response = client.get(f"/api/versions/{ws}/yaml-section/model.yaml")
        assert response.status_code == 422

    def test_write_preserves_comments_elsewhere(self, client, ws, national_scale):
        url = f"/api/versions/{ws}/yaml-section/model.yaml"
        before = (national_scale / "model.yaml").read_text()

        data = client.get(url, params={"section": "config"}).json()["data"]
        data["init"]["name"] = "Renamed by test"
        assert client.put(
            url, params={"section": "config"}, json={"data": data}
        ).json() == {"ok": True}

        after = (national_scale / "model.yaml").read_text()
        assert "Renamed by test" in after
        # A comment from a different section must be untouched.
        assert "# --8<-- [start:import]" in after
        assert len(before.splitlines()) == len(after.splitlines())


class TestStructure:
    def test_component_tree_names_the_defining_file(self, client, ws):
        tree = client.get(f"/api/versions/{ws}/component-tree/").json()
        assert "techs" in tree and "nodes" in tree
        entry = tree["techs"]["entries"][0]
        assert set(entry) >= {"name", "file"}

    def test_import_graph_is_rooted_at_model_yaml(self, client, ws):
        graph = client.get(f"/api/versions/{ws}/import-graph/").json()
        roots = [node for node in graph["nodes"] if node["type"] == "root"]
        assert [node["id"] for node in roots] == ["model.yaml"]
        assert graph["edges"]

    @pytest.mark.parametrize("kind", ["tech", "node"])
    def test_data_table_params(self, client, ws, kind):
        body = client.get(
            f"/api/versions/{ws}/data-table-params/", params={"kind": kind}
        ).json()
        assert body["kind"] == kind
        assert isinstance(body["params"], dict)

    def test_tech_params_come_from_the_costs_table(self, client, ws):
        params = client.get(
            f"/api/versions/{ws}/data-table-params/", params={"kind": "tech"}
        ).json()["params"]
        assert params, "expected the costs data table to yield tech parameters"
        entry = next(iter(params.values()))
        info = next(iter(entry.values()))
        assert set(info) >= {"value", "time_varying", "source"}

    def test_invalid_kind_is_rejected(self, client, ws):
        response = client.get(
            f"/api/versions/{ws}/data-table-params/", params={"kind": "bogus"}
        )
        assert response.status_code == 422


class TestSchema:
    def test_schema_is_generated_from_installed_calliope(self, client):
        import calliope

        body = client.get("/api/schema/calliope/").json()
        assert body["type"] == "object"
        assert body["x-calliope"]["version"] == calliope.__version__

    def test_parameter_registry_carries_units_and_titles(self, client):
        registry = client.get("/api/schema/calliope/").json()["x-calliope"]["registry"]
        assert len(registry["parameters"]) > 50
        assert registry["parameters"]["flow_cap_max"]["title"]


class TestComponentUnits:
    """The units Calliope's own math declares.

    Read from the installed version rather than checked in, so they cannot drift
    from what is actually validating and running models — and read from a wider
    set of sections than the editor's registry, because a results chart plots
    variables and global expressions, which are not editor fields.
    """

    def test_covers_the_sections_the_registry_deliberately_omits(self):
        from calliope_studio.modeldef.schema import component_units

        units = component_units()
        # Variables and global expressions: exactly what a results chart draws.
        assert units["flow_cap"] == "power"
        assert units["flow_out"] == "energy"
        assert units["cost"] == "cost"
        # And parameters, which the table plots.
        assert units["flow_cap_max"].startswith("power")

    def test_the_earliest_definition_wins(self):
        from calliope_studio.modeldef.schema import component_units

        # `milp` re-declares `flow_cap` to add bounds and states no unit; `base`
        # is authoritative and must not be overwritten by that silence.
        assert component_units()["flow_cap"] == "power"

    def test_passes_the_declarations_on_exactly_as_written(self):
        from calliope_studio.modeldef.schema import component_units

        # Inconsistent by nature — LaTeX here, a trailing full stop there, and
        # one upstream `\{cost}` typo. Normalising is presentation, and belongs
        # in the one place that renders it rather than here.
        assert component_units()["cost_operation_variable"].startswith("$")


class TestValidation:
    """One endpoint, which escalates.

    The syntax tier runs in-process and, only if it finds nothing, a build-only
    run is started and its id returned to poll. Both paths answer with the same
    keys so a client reads one shape.
    """

    def test_broken_yaml_is_reported_with_a_line_number(
        self, client, ws, national_scale
    ):
        (national_scale / "broken.yaml").write_text("a: 1\n  b: [unclosed\n")
        body = client.post(f"/api/versions/{ws}/validate/").json()

        assert body["phase"] == "syntax"
        assert body["status"] == "done"
        errors = body["result"]["errors"]
        assert len(errors) == 1
        assert errors[0]["file"] == "broken.yaml"
        assert errors[0]["line"] is not None
        assert errors[0]["severity"] == "error"
        assert errors[0]["tier"] == "syntax"

    def test_a_syntax_error_starts_no_worker(self, client, ws, national_scale):
        """The whole point of keeping the cheap tier.

        A file that will not parse also fails `read_yaml`, so a build would cost
        a subprocess to produce a vaguer version of a problem already located to
        the line.
        """
        (national_scale / "broken.yaml").write_text("a: 1\n  b: [unclosed\n")
        body = client.post(f"/api/versions/{ws}/validate/").json()

        assert body["task_id"] is None
        assert not (national_scale / "calliope-studio").exists()

    def test_clean_syntax_escalates_to_a_build(self, client, ws):
        response = client.post(f"/api/versions/{ws}/validate/")

        assert response.status_code == 202
        body = response.json()
        assert body["phase"] == "build"
        assert body["status"] == "running"
        assert body["task_id"]
        assert body["result"] is None
