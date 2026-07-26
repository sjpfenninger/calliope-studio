"""The results layer: catalogue, queries, and the Arrow wire format."""

import io
import json

import numpy as np
import pyarrow as pa
import pytest

from calligraph.results import frames, geo, summaries
from calligraph.results.catalog import (
    SYNTHETIC_VARIABLES,
    base_tech_members,
    build_catalog,
    get_array,
)
from calligraph.results.colors import DEFAULT_PALETTE, tech_colors
from calligraph.results.query import Query, choose_index, filter_selectors, reduce_array
from calligraph.results.store import ResultsNotFound, ResultStore, results_id


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
        assert np.allclose(
            computed.values, expected.values, equal_nan=True
        ), "flow* must stay net flow, with missing sides treated as zero"

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

    def test_bounds_enclose_every_node_with_margin(self, results):
        (west, south), (east, north) = geo.bounds(results.model)
        for feature in geo.nodes_geojson(results.model)["features"]:
            longitude, latitude = feature["geometry"]["coordinates"]
            assert west < longitude < east
            assert south < latitude < north

    def test_geojson_bundles_everything_the_map_needs(self, results):
        payload = geo.geojson(results.model)
        assert set(payload) == {"nodes", "links", "bounds"}


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
