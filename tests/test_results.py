"""The results layer: catalogue, queries, and the Arrow wire format."""

import io
import json
from types import SimpleNamespace

import numpy as np
import pyarrow as pa
import pytest
import xarray as xr

from calliope_studio.results import frames, geo, summaries
from calliope_studio.results.catalog import (
    SYNTHETIC_VARIABLES,
    base_tech_members,
    build_catalog,
    get_array,
    tech_base_techs,
)
from calliope_studio.results.colors import DEFAULT_PALETTE, tech_colors
from calliope_studio.results.links import Link, link_orientation, transmission_links
from calliope_studio.results.query import (
    Query,
    choose_index,
    filter_selectors,
    reduce_array,
)
from calliope_studio.results.store import ResultsNotFound, ResultStore, results_id


def read_stream(table: pa.Table, batch_rows: int = 4096) -> pa.Table:
    """Round-trips a table through the IPC stream, as the browser would."""
    payload = b"".join(frames.stream_ipc(table, batch_rows=batch_rows))
    return pa.ipc.open_stream(io.BytesIO(payload)).read_all()


class TestStore:
    def test_handle_is_stable_for_a_path(self, solved_results):
        assert results_id(solved_results) == results_id(solved_results)

    def test_registering_then_loading(self, solved_results):
        store = ResultStore()
        handle = store.register(solved_results)
        assert store.get(handle).path == solved_results.resolve()

    def test_unknown_handle_raises(self):
        with pytest.raises(ResultsNotFound):
            ResultStore().get("nope")

    def test_missing_file_raises(self, tmp_path):
        store = ResultStore()
        handle = store.register(tmp_path / "gone.nc")
        with pytest.raises(ResultsNotFound):
            store.get(handle)

    def test_inputs_and_results_share_one_namespace(self, results):
        # A caller asks for a variable by name without knowing which side it
        # came from.
        assert "flow_cap" in results.dataset
        assert "base_tech" in results.dataset

    def test_path_for_does_not_load_the_model(self, solved_results, monkeypatch):
        """Knowing *where* results came from must not cost a deserialisation.

        A solved model is roughly seventeen times its file size in memory, so the
        reverse-lookup endpoint cannot afford to load one to report a path.
        """
        from calliope_studio.results import store as store_module

        monkeypatch.setattr(
            store_module,
            "_read",
            lambda path: pytest.fail("path_for must not load the model"),
        )
        store = ResultStore()
        handle = store.register(solved_results)
        assert store.path_for(handle) == solved_results.resolve()

    def test_an_unregistered_handle_resolves_through_candidates(self, solved_results):
        """A bookmarked results URL survives a restart.

        A handle is a truncated hash of a path and cannot be inverted, so a handle
        this process never minted is only resolvable by hashing the paths it could
        have come from. Without this, `catalog/` 404s until something happens to
        list the runs again.
        """
        handle = results_id(solved_results)
        fresh = ResultStore(candidates=lambda: [solved_results])

        assert fresh.path_for(handle) == solved_results.resolve()
        assert fresh.get(handle).path == solved_results.resolve()

    def test_candidates_that_do_not_match_are_not_offered(self, solved_results):
        store = ResultStore(candidates=lambda: [solved_results])
        assert store.path_for("0" * 16) is None


class TestModelCacheBudget:
    """The cache is bounded in bytes, not in models.

    Keeping eight was free while at most one or two were ever live. With several
    run tabs open — and comparing runs being the point — eight `urban_scale`
    models is 650 MB and eight real national models is thirteen gigabytes.
    """

    @pytest.fixture
    def counting_loader(self, monkeypatch):
        """Replaces the real reader, so eviction is observable without the memory."""
        from calliope_studio.results import store as store_module

        calls: list[str] = []

        def fake_read(path_str):
            calls.append(path_str)
            return object()

        monkeypatch.setattr(store_module, "_read", fake_read)
        monkeypatch.setattr(store_module, "_cache", store_module._ModelCache())
        return calls, store_module

    def _sized_file(self, tmp_path, name, megabytes):
        path = tmp_path / name
        path.write_bytes(b"\0" * (megabytes * 1024 * 1024))
        return path

    def test_a_tight_budget_evicts_the_least_recently_used(
        self, counting_loader, tmp_path, monkeypatch
    ):
        calls, store_module = counting_loader
        monkeypatch.setenv("CALLIOPE_STUDIO_RESULTS_BUDGET_MB", "1")

        first = str(self._sized_file(tmp_path, "a.nc", 1))
        second = str(self._sized_file(tmp_path, "b.nc", 1))

        store_module._load(first)
        store_module._load(second)
        store_module._load(first)  # evicted, so read again

        assert calls == [first, second, first]

    def test_a_generous_budget_keeps_both(self, counting_loader, tmp_path, monkeypatch):
        calls, store_module = counting_loader
        monkeypatch.setenv("CALLIOPE_STUDIO_RESULTS_BUDGET_MB", "4096")

        first = str(self._sized_file(tmp_path, "a.nc", 1))
        second = str(self._sized_file(tmp_path, "b.nc", 1))

        store_module._load(first)
        store_module._load(second)
        store_module._load(first)

        assert calls == [first, second]

    def test_one_entry_is_always_retained(self, counting_loader, tmp_path, monkeypatch):
        """A model bigger than the whole budget must still be openable."""
        calls, store_module = counting_loader
        monkeypatch.setenv("CALLIOPE_STUDIO_RESULTS_BUDGET_MB", "1")

        huge = str(self._sized_file(tmp_path, "huge.nc", 2))
        store_module._load(huge)
        store_module._load(huge)

        assert calls == [huge]

    def test_forget_releases_the_loaded_model(
        self, counting_loader, tmp_path, monkeypatch
    ):
        """`forget` used to free nothing: the `lru_cache` held a strong reference.

        So deleting a run left its solved model resident for the life of the
        process.
        """
        calls, store_module = counting_loader
        monkeypatch.setenv("CALLIOPE_STUDIO_RESULTS_BUDGET_MB", "4096")

        path = self._sized_file(tmp_path, "a.nc", 1)
        store = ResultStore()
        handle = store.register(path)

        store.get(handle)
        store.forget(handle)
        store.register(path)
        store.get(handle)

        assert calls == [str(path.resolve())] * 2


class TestCatalog:
    def test_categories_are_disjoint_and_complete(self, results):
        catalog = build_catalog(results.dataset)
        assert set(catalog.static) | set(catalog.timeseries) >= set(catalog.all)
        assert not set(catalog.static) & set(
            name for name in catalog.timeseries if name != "flow*"
        )

    def test_synthetic_flow_is_offered_as_a_timeseries(self, results):
        assert "flow*" in build_catalog(results.dataset).timeseries

    def test_flow_star_is_out_minus_in(self, results):
        computed = get_array(results.dataset, "flow*")
        expected = results.dataset.flow_out.fillna(0) - results.dataset.flow_in.fillna(
            0
        )
        assert np.allclose(computed.values, expected.values, equal_nan=True), (
            "flow* must stay net flow, with missing sides treated as zero"
        )

    def test_synthetic_unavailable_without_its_inputs(self, results):
        stripped = results.dataset.drop_vars(["flow_in"])
        assert not SYNTHETIC_VARIABLES["flow*"].is_available(stripped)
        assert "flow*" not in build_catalog(stripped).timeseries

    def test_static_nodes_have_a_nodes_dimension(self, results):
        catalog = build_catalog(results.dataset)
        for name in catalog.static_nodes:
            assert "nodes" in results.dataset[name].dims

    def test_static_links_need_transmission_data(self, results):
        transmission = base_tech_members(results.model, "transmission")
        assert transmission, "the example model should have transmission techs"
        catalog = build_catalog(results.dataset, transmission_techs=transmission)
        assert catalog.static_links
        assert set(catalog.static_links) <= set(catalog.static)

    def test_no_transmission_techs_means_no_links(self, results):
        assert build_catalog(results.dataset, transmission_techs=[]).static_links == ()

    def test_every_variable_reports_its_dimensions(self, results):
        catalog = build_catalog(results.dataset)
        assert set(catalog.dims) >= set(catalog.all)
        for name in catalog.all:
            assert catalog.dims[name] == tuple(
                str(dim) for dim in results.dataset[name].dims
            )

    def test_synthetic_dimensions_come_from_its_inputs(self, results):
        catalog = build_catalog(results.dataset)
        # `flow*` is never materialised to answer this, so the answer has to be
        # the union of what it is computed from.
        assert "timesteps" in catalog.dims["flow*"]
        assert set(catalog.dims["flow*"]) == set(catalog.dims["flow_out"]) | set(
            catalog.dims["flow_in"]
        )


class TestBaseTechs:
    """The tech→type map the results sidebar groups its filters by."""

    def test_every_tech_is_classified(self, results):
        mapped = tech_base_techs(results.model)
        assert set(mapped) == set(results.model.inputs.techs.to_index())

    def test_it_agrees_with_base_tech_members(self, results):
        """One question, one answer — the two must not be able to disagree."""
        mapped = tech_base_techs(results.model)
        for base_tech in set(mapped.values()):
            assert sorted(
                tech for tech, value in mapped.items() if value == base_tech
            ) == base_tech_members(results.model, base_tech)

    def test_a_model_without_base_tech_is_not_an_error(self):
        assert tech_base_techs(SimpleNamespace(inputs=xr.Dataset())) == {}

    def test_an_unclassified_tech_is_absent_rather_than_guessed(self):
        """The sidebar's `other` bucket must be its own decision, not ours.

        The array is built object-dtype by hand rather than through `stub_model`,
        because numpy turns `["supply", nan]` into `["supply", "nan"]` — strings —
        and the test would then be asserting against its own fixture rather than
        against the shape Calliope actually produces.
        """
        model = SimpleNamespace(
            inputs=xr.Dataset(
                {
                    "base_tech": xr.DataArray(
                        np.array(["supply", np.nan], dtype=object),
                        dims="techs",
                        coords={"techs": ["pv", "mystery"]},
                    )
                }
            )
        )
        assert tech_base_techs(model) == {"pv": "supply"}


class TestColors:
    def test_every_tech_gets_a_colour(self, results):
        colors = tech_colors(results.model)
        assert set(colors) == set(results.model.results.techs.to_index())
        assert all(value.startswith("#") for value in colors.values())

    def test_assignment_is_deterministic(self, results):
        assert tech_colors(results.model) == tech_colors(results.model)

    def test_fallbacks_come_from_the_palette(self, results):
        colors = tech_colors(results.model)
        defined = set()
        if "color" in results.model.inputs:
            defined = {
                tech
                for tech, value in results.model.inputs.color.to_series().items()
                if isinstance(value, str) and value.startswith("#")
            }
        for tech, color in colors.items():
            if tech not in defined:
                assert color in DEFAULT_PALETTE


class TestSelectors:
    def test_irrelevant_dimensions_are_dropped(self, results):
        array = get_array(results.dataset, "flow_cap")
        applied = filter_selectors(array, {"techs": ["ccgt"], "not_a_dim": ["x"]})
        assert applied == {"techs": ["ccgt"]}

    def test_none_means_unconstrained(self, results):
        array = get_array(results.dataset, "flow_cap")
        assert filter_selectors(array, {"techs": None}) == {}

    def test_additional_subset_intersects(self, results):
        array = get_array(results.dataset, "flow_cap")
        applied = filter_selectors(
            array, {"techs": ["ccgt", "csp"]}, additional_subset={"techs": ["csp"]}
        )
        assert applied == {"techs": ["csp"]}

    def test_unknown_members_are_dropped(self, results):
        """A selection can outlive the model it was made against.

        Passing an unknown member through to xarray raises a KeyError naming
        the coordinate, which is indistinguishable from a missing variable by
        the time it reaches a route handler.
        """
        array = get_array(results.dataset, "flow_cap")
        applied = filter_selectors(array, {"techs": ["ccgt", "removed_last_week"]})
        assert applied == {"techs": ["ccgt"]}

    def test_selecting_only_unknown_members_yields_nothing(self, results):
        array = get_array(results.dataset, "flow_cap")
        assert filter_selectors(array, {"techs": ["gone"]}) == {"techs": []}

    def test_a_query_with_unknown_members_still_reduces(self, results):
        reduced = reduce_array(
            results.dataset, Query(variable="flow*", selectors={"techs": ["gone"]})
        )
        assert reduced.sizes["techs"] == 0


class TestReduction:
    def test_resampling_reduces_the_timesteps(self, results):
        raw = reduce_array(results.dataset, Query(variable="flow*"))
        daily = reduce_array(results.dataset, Query(variable="flow*", resample="1D"))
        assert daily.sizes["timesteps"] < raw.sizes["timesteps"]

    def test_sum_by_removes_the_dimension(self, results):
        reduced = reduce_array(results.dataset, Query(variable="flow*", sum_by="nodes"))
        assert "nodes" not in reduced.dims

    def test_sum_by_an_absent_dimension_is_harmless(self, results):
        reduced = reduce_array(
            results.dataset, Query(variable="flow*", sum_by="not_a_dim")
        )
        assert "timesteps" in reduced.dims

    def test_time_range_subsets(self, results):
        timesteps = results.dataset.timesteps.to_index()
        window = (str(timesteps[0]), str(timesteps[len(timesteps) // 2]))
        reduced = reduce_array(
            results.dataset, Query(variable="flow*", time_range=window)
        )
        assert reduced.sizes["timesteps"] < len(timesteps)

    def test_index_defaults_to_timesteps(self, results):
        array = reduce_array(results.dataset, Query(variable="flow*"))
        assert choose_index(array, None) == "timesteps"

    def test_index_falls_back_to_the_largest_dimension(self, results):
        array = reduce_array(results.dataset, Query(variable="flow_cap"))
        chosen = choose_index(array, None)
        assert chosen in array.dims
        assert array.sizes[chosen] == max(array.sizes.values())


class TestArrowFrames:
    def test_wide_by_series_shape(self, results):
        query = Query(variable="flow*", resample="1D", sum_by="nodes")
        table = frames.build_table(reduce_array(results.dataset, query), query)
        assert table.schema.names[0] == "timesteps"
        # Every other column is one series, and is numeric.
        for field in list(table.schema)[1:]:
            assert field.type == pa.float64()

    def test_series_identity_travels_as_field_metadata(self, results):
        query = Query(variable="flow*", resample="1D", sum_by="nodes")
        table = frames.build_table(
            reduce_array(results.dataset, query),
            query,
            colors=tech_colors(results.model),
        )
        field = table.schema.field(1)
        coordinates = json.loads(field.metadata[b"dims"])
        assert "techs" in coordinates
        # Colour rides along so the chart never has to join against a palette.
        assert field.metadata[b"color"].decode().startswith("#")

    def test_schema_metadata_describes_the_query(self, results):
        query = Query(variable="flow*", resample="1D", sum_by="nodes")
        table = frames.build_table(reduce_array(results.dataset, query), query)
        metadata = {k.decode(): v.decode() for k, v in table.schema.metadata.items()}
        assert metadata["variable"] == "flow*"
        assert metadata["index"] == "timesteps"
        assert metadata["order"] == "time"
        assert "techs" in json.loads(metadata["series_dims"])

    def test_empty_series_are_dropped(self, results):
        query = Query(variable="flow*", resample="1D", drop_zeros=True)
        kept = frames.build_table(reduce_array(results.dataset, query), query)
        query_all = Query(variable="flow*", resample="1D", drop_zeros=False)
        everything = frames.build_table(
            reduce_array(results.dataset, query_all), query_all
        )
        assert kept.num_columns < everything.num_columns

    def test_duration_order_sorts_each_series_independently(self, results):
        query = Query(variable="flow*", sum_by="nodes", order="duration")
        table = frames.build_table(reduce_array(results.dataset, query), query)
        assert table.schema.names[0] == "period"

        for name in table.schema.names[1:]:
            values = table.column(name).to_numpy(zero_copy_only=False)
            present = values[~np.isnan(values)]
            assert np.all(np.diff(present) <= 0), f"{name} is not descending"

    def test_duration_order_preserves_the_values(self, results):
        by_time = Query(variable="flow*", sum_by="nodes")
        by_duration = Query(variable="flow*", sum_by="nodes", order="duration")
        timed = frames.build_table(reduce_array(results.dataset, by_time), by_time)
        sorted_ = frames.build_table(
            reduce_array(results.dataset, by_duration), by_duration
        )
        name = timed.schema.names[1]
        original = np.sort(timed.column(name).to_numpy(zero_copy_only=False))
        curve = np.sort(sorted_.column(name).to_numpy(zero_copy_only=False))
        assert np.allclose(original, curve, equal_nan=True)

    def test_static_variables_use_a_dimension_as_the_index(self, results):
        query = Query(variable="flow_cap")
        table = frames.build_table(reduce_array(results.dataset, query), query)
        assert table.schema.names[0] in results.dataset.flow_cap.dims

    @pytest.mark.parametrize("batch_rows", [1, 7, 4096])
    def test_ipc_stream_round_trips_at_any_chunk_size(self, results, batch_rows):
        query = Query(variable="flow*", resample="1D", sum_by="nodes")
        table = frames.build_table(reduce_array(results.dataset, query), query)
        back = read_stream(table, batch_rows=batch_rows)

        assert back.schema.equals(table.schema)
        # NaN != NaN under Arrow equality, so compare the way a consumer would.
        assert back.to_pandas().equals(table.to_pandas())

    def test_stream_yields_more_than_one_chunk_when_batched(self, results):
        query = Query(variable="flow*", sum_by="nodes")
        table = frames.build_table(reduce_array(results.dataset, query), query)
        chunks = list(frames.stream_ipc(table, batch_rows=2))
        assert len(chunks) > 2, "a batched stream should arrive in pieces"


class TestGeo:
    def test_nodes_are_points_in_lon_lat(self, results):
        collection = geo.nodes_geojson(results.model)
        assert collection["type"] == "FeatureCollection"
        assert collection["features"]
        for feature in collection["features"]:
            longitude, latitude = feature["geometry"]["coordinates"]
            assert -180 <= longitude <= 180
            assert -90 <= latitude <= 90

    def test_links_are_two_ended_lines(self, results):
        collection = geo.links_geojson(results.model, colors=tech_colors(results.model))
        assert collection["features"]
        for feature in collection["features"]:
            assert feature["geometry"]["type"] == "LineString"
            assert len(feature["geometry"]["coordinates"]) >= 2
            assert feature["properties"]["node_from"]
            assert feature["properties"]["node_to"]

    def test_links_are_drawn_the_way_they_were_declared(self, results):
        """Coordinate order is arbitrary; `link_from` is not."""
        oriented = link_orientation(results.model)
        assert oriented, "the example model should declare its endpoints"
        positions = {
            feature["properties"]["node"]: feature["geometry"]["coordinates"]
            for feature in geo.nodes_geojson(results.model)["features"]
        }
        for feature in geo.links_geojson(results.model, orientation=oriented)[
            "features"
        ]:
            properties = feature["properties"]
            assert oriented[properties["tech"]] == (
                properties["node_from"],
                properties["node_to"],
            )
            # And the line runs the same way as the properties say it does.
            assert (
                feature["geometry"]["coordinates"][0]
                == positions[properties["node_from"]]
            )

    def test_bounds_enclose_every_node_with_margin(self, results):
        (west, south), (east, north) = geo.bounds(results.model)
        for feature in geo.nodes_geojson(results.model)["features"]:
            longitude, latitude = feature["geometry"]["coordinates"]
            assert west < longitude < east
            assert south < latitude < north

    def test_geojson_bundles_everything_the_map_needs(self, results):
        payload = geo.geojson(results.model)
        assert set(payload) == {"nodes", "links", "bounds", "colors"}

    def test_shape_matches_the_definition_endpoint(self, results, national_scale):
        """One map component renders either, so both must agree on the shape."""
        from calliope_studio.modeldef import geo as definition_geo

        assert set(geo.geojson(results.model)) == set(
            definition_geo.geojson(national_scale)
        )


def stub_model(base_techs: dict, inputs=None, definition=None):
    """A model just real enough for link resolution.

    `inputs` and `definition` are `{tech: (from, to)}`; passing None for either
    leaves that source absent entirely, which is the case that matters — the two
    are absent in different real models.
    """
    names = list(base_techs)
    variables = {
        "base_tech": xr.DataArray(
            list(base_techs.values()), dims="techs", coords={"techs": names}
        )
    }
    if inputs is not None:
        for position, key in enumerate(("link_from", "link_to")):
            variables[key] = xr.DataArray(
                [inputs.get(name, ("", ""))[position] for name in names],
                dims="techs",
                coords={"techs": names},
            )

    model = SimpleNamespace(inputs=xr.Dataset(variables))
    if definition is not None:
        model.definition = SimpleNamespace(
            techs=SimpleNamespace(
                root={
                    name: (
                        SimpleNamespace(
                            link_from=definition[name][0], link_to=definition[name][1]
                        )
                        if name in definition
                        # Absent, not None, on a tech that never declared them.
                        else SimpleNamespace()
                    )
                    for name in names
                }
            )
        )
    return model


class TestLinks:
    def test_endpoints_come_from_the_definition(self, results):
        """The path `inputs` cannot cover.

        `national_scale` declares its links in YAML, and `_links_to_node_format`
        consumes that during preprocessing — so `inputs.link_from` does not exist
        and `model.definition` is the only remaining record.
        """
        assert "link_from" not in results.model.inputs
        links = transmission_links(results.model)
        assert links, "the example model should have transmission techs"
        assert all(link.node_from and link.node_to for link in links)
        by_tech = {link.tech: (link.node_from, link.node_to) for link in links}
        assert by_tech["region1_to_region2"] == ("region1", "region2")

    def test_every_transmission_tech_is_listed(self, results):
        assert [link.tech for link in transmission_links(results.model)] == sorted(
            base_tech_members(results.model, "transmission")
        )

    def test_order_follows_the_caller(self, results):
        members = base_tech_members(results.model, "transmission")
        reversed_order = list(reversed(members))
        links = transmission_links(results.model, order=reversed_order)
        assert [link.tech for link in links] == reversed_order

    def test_unranked_techs_go_last(self):
        model = stub_model(
            {"a_to_b": "transmission", "b_to_c": "transmission"},
            definition={"a_to_b": ("a", "b"), "b_to_c": ("b", "c")},
        )
        links = transmission_links(model, order=["b_to_c"])
        assert [link.tech for link in links] == ["b_to_c", "a_to_b"]

    def test_no_transmission_means_no_links(self):
        model = stub_model({"pv": "supply"}, definition={})
        assert transmission_links(model) == []

    def test_a_model_without_base_tech_is_not_an_error(self):
        assert transmission_links(SimpleNamespace(inputs=xr.Dataset())) == []

    def test_inputs_win_over_the_definition(self):
        """A data table is the model as it was actually built."""
        model = stub_model(
            {"a_to_b": "transmission"},
            inputs={"a_to_b": ("a", "b")},
            definition={"a_to_b": ("b", "a")},
        )
        assert link_orientation(model) == {"a_to_b": ("a", "b")}

    def test_blank_endpoints_count_as_absent(self):
        """Non-link techs carry `link_from` as an empty string once tabular."""
        model = stub_model(
            {"pv": "supply", "a_to_b": "transmission"}, inputs={"a_to_b": ("a", "b")}
        )
        assert link_orientation(model) == {"a_to_b": ("a", "b")}

    def test_a_link_with_unknown_ends_is_still_a_link(self):
        model = stub_model({"a_to_b": "transmission"}, definition={})
        assert transmission_links(model) == [Link("a_to_b", None, None)]

    def test_a_broken_definition_costs_labels_not_the_catalogue(self):
        model = stub_model({"a_to_b": "transmission"})
        model.definition = SimpleNamespace()  # Calliope changed shape under us
        assert transmission_links(model) == [Link("a_to_b", None, None)]

    def test_label_falls_back_to_the_raw_name(self):
        assert Link("a_to_b", "a", "b").label == "a → b"
        assert Link("a_to_b").label == "a_to_b"

    def test_as_dict_is_the_wire_shape(self):
        assert Link("a_to_b", "a", "b").as_dict() == {
            "tech": "a_to_b",
            "from": "a",
            "to": "b",
        }


class TestSummaries:
    def test_summary_is_plain_json(self, results):
        payload = summaries.summaries(results)
        json.dumps(payload)  # must not raise
        assert payload["model"]["techs"] > 0
        assert payload["model"]["termination_condition"] == "optimal"

    def test_config_sections_are_present(self, results):
        payload = summaries.summaries(results)
        assert payload["solve_config"]["solver"]
        assert "build_config" in payload
