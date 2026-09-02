"""`modeldef/geo.py` against its client-side twin, `web/src/lib/mapGeo.ts`.

The same question is answered twice, deliberately: the server can only draw what
was last *saved*, and the whole point of an editing map is the unsaved state — a
node mid-drag, a link that exists only in the form. So the browser builds the
geometry from the editor's own entries, using the same rules.

Two implementations kept in step by eye is exactly the failure this repository
has a whole section of doctrine about, and this pair had nothing holding them
together at all. `tests/fixtures/map_geo.json` is the seam: this file writes it
from the Python reading of Calliope's two example models, and
`web/src/lib/mapGeo.test.ts` asserts the TypeScript builders reproduce it. A
change to either side that the other does not match fails on one side or the
other.

The fixture is committed rather than generated at test time because the
TypeScript suite cannot run Python — and because a fixture that regenerates
itself asserts nothing.
"""

import inspect
import json
import shutil
from pathlib import Path

import pytest

from calliope_studio.modeldef import geo

FIXTURE = Path(__file__).parent / "fixtures" / "map_geo.json"

MODELS = ("national_scale", "urban_scale")


def _example_models_dir() -> Path:
    import calliope

    return Path(inspect.getfile(calliope)).parent / "example_models"


@pytest.fixture(scope="module")
def payloads(tmp_path_factory) -> dict:
    """The current Python reading of both stock models."""
    directory = tmp_path_factory.mktemp("geo")
    built = {}
    for name in MODELS:
        root = directory / name
        shutil.copytree(_example_models_dir() / name, root)
        built[name] = geo.geojson(root)
    return built


class TestTheFixtureIsCurrent:
    """It has to be regenerated when either the models or the reading change.

    If this fails, the fixture is stale: rewrite it from `payloads` and run
    `pnpm test mapGeo` to see whether the TypeScript side still agrees. A change
    here that the twin does not match is the thing this pair exists to catch.
    """

    def test_the_committed_fixture_matches_what_geo_reads_now(self, payloads):
        committed = json.loads(FIXTURE.read_text(encoding="utf-8"))
        assert committed == json.loads(json.dumps(payloads))

    @pytest.mark.parametrize("model", MODELS)
    def test_each_model_contributes_geometry_to_compare(self, payloads, model):
        """An empty fixture would pass every assertion on both sides."""
        assert payloads[model]["nodes"]["features"]
        assert payloads[model]["links"]["features"]
        assert payloads[model]["bounds"] is not None


class TestTheRulesTheTwinAlsoImplements:
    """The three that are easy to get subtly different, asserted on this side."""

    def test_a_node_missing_a_coordinate_is_not_on_the_map(self, tmp_path):
        """Half a coordinate pair is the ordinary state of one being typed."""
        nodes = {
            "placed": {"latitude": 40, "longitude": -2},
            "half": {"latitude": 40},
            "none": {"techs": {}},
        }
        positions = geo.node_positions(tmp_path, nodes)
        assert set(positions) == {"placed"}

    def test_a_link_to_an_unplaced_node_is_not_drawn(self, tmp_path):
        collection = geo.links_geojson(tmp_path, positions={"a": [1.0, 2.0]})
        assert collection["features"] == []

    def test_a_degenerate_box_gets_a_whole_degree(self):
        """Every node at one point leaves no span to take a fraction of."""
        points = {
            "type": "FeatureCollection",
            "features": [
                {"geometry": {"type": "Point", "coordinates": [5.0, 50.0]}},
                {"geometry": {"type": "Point", "coordinates": [5.0, 50.0]}},
            ],
        }
        assert geo.bounds(points) == [
            [5.0 - geo.DEGENERATE_PADDING, 50.0 - geo.DEGENERATE_PADDING],
            [5.0 + geo.DEGENERATE_PADDING, 50.0 + geo.DEGENERATE_PADDING],
        ]

    def test_the_box_takes_a_tenth_of_the_larger_span(self):
        points = {
            "type": "FeatureCollection",
            "features": [
                {"geometry": {"type": "Point", "coordinates": [0.0, 0.0]}},
                {"geometry": {"type": "Point", "coordinates": [10.0, 2.0]}},
            ],
        }
        assert geo.bounds(points) == [[-1.0, -1.0], [11.0, 3.0]]
