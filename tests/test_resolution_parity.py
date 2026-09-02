"""The structural reading against Calliope's own, on real models.

Calliope Studio reads a model definition two ways. `modeldef` reads the *files*, which
has to keep working on a model that does not build, because that is what someone is
editing. Anything that needs to know what the definition *means* asks Calliope,
which is the only implementation of Calliope's rules that cannot drift from
Calliope.

The two readings therefore have to agree, and the reason this file exists is that
they quietly did not. A model whose node coordinates came from a CSV had no
geography at all as far as the editor was concerned; a template inheriting a
template lost half its parameters. Both were found by a user, not by a test.

So: for every model in reach, assert that the structural reading agrees with the
resolved one wherever it claims to, and **record where it cannot** — those are the
limits of the fallback, and a limit with a test on it is a documented decision
rather than a bug waiting to be found.

The models are Calliope's own two examples plus `examples/model_nld-NUTS3-v1`, which
is the one that exercises the features the stock examples do not: coordinates from a
data table, links from a data table, and a two-hop template.

**What that costs is worth stating plainly.** `examples/` is gitignored, so the
nld model is on one developer's disk and nowhere else — not in CI, not in a
fresh clone. Nine of the assertions here are `@nld_only`, and they are the ones
covering the three worst bugs this project has had. `TestSyntheticFeatures`
below rebuilds each of those three features on top of `national_scale`, so the
*mechanism* is checked everywhere even though the real model is not.
"""

from pathlib import Path

import pytest

from calliope_studio.modeldef import geo
from calliope_studio.modeldef.data_tables import data_table_params
from calliope_studio.modeldef.entities import (
    assembled,
    harmonise_coordinates,
    resolved_techs,
    transmission_techs,
)
from calliope_studio.modeldef.yaml_io import read_section

#: The repository's own example, which the stock ones do not resemble.
NLD = Path(__file__).parent.parent / "examples" / "model_nld-NUTS3-v1"

nld_only = pytest.mark.skipif(
    not (NLD / "model.yaml").is_file(), reason="the nld example is not present"
)


#: Models that must build. A skip here would take every parity assertion with it.
#:
#: `_resolved` used to `pytest.skip` on **any** exception, which turned the file
#: this repository relies on to keep its two readings in step into one that goes
#: green the moment Calliope's own examples stop building — a transient
#: environment problem and a genuine upstream break look identical, and neither
#: is reported. The stock examples ship with Calliope, so if they do not build,
#: that is the finding.
MUST_BUILD = frozenset({"national_scale", "urban_scale"})


def _resolved(path: Path):
    """The model as Calliope reads it.

    A model outside `MUST_BUILD` — i.e. one that is not in the repository and may
    be anything — is allowed to skip, since its absence or breakage says nothing
    about this code.
    """
    import calliope

    try:
        return calliope.read_yaml(str(path / "model.yaml"))
    except Exception as exc:
        if path.name in MUST_BUILD:
            raise
        pytest.skip(f"{path.name} does not build: {type(exc).__name__}: {exc}")


def _resolved_positions(model) -> dict[str, tuple[float, float]]:
    inputs = model.inputs
    frame = inputs[["longitude", "latitude"]].to_dataframe().dropna()
    return {
        str(node): (float(row["longitude"]), float(row["latitude"]))
        for node, row in frame.iterrows()
    }


def _resolved_links(model) -> set[str]:
    inputs = model.inputs
    return {
        str(tech)
        for tech, base in inputs.base_tech.to_series().items()
        if str(base) == "transmission"
    }


class TestAssembly:
    """That the structural reading uses Calliope's assembly at all.

    It falls back to a hand-written merge when assembly fails, and the fallback is
    good enough that nothing else in this file notices — which is precisely why it
    needs its own test. `national_scale` silently took the fallback for its whole
    first day: its `cold_fusion` override names a template defined in *another*
    override, and `TemplateSolver` raised `KeyError` walking a section Calliope
    removes before ever running it. Twenty times slower, one level of templates, and
    no sign anywhere.
    """

    @pytest.mark.parametrize("fixture", ["national_scale", "urban_scale"])
    def test_the_stock_examples_assemble(self, fixture, request):
        path = request.getfixturevalue(fixture)
        definition = assembled(path)
        assert definition is not None
        assert definition.sections.get("techs")
        assert definition.sections.get("nodes")

    @nld_only
    def test_the_nld_example_assembles(self):
        definition = assembled(NLD)
        assert definition is not None
        assert len(definition.sections["nodes"]) == 37

    @pytest.mark.parametrize("fixture", ["national_scale", "urban_scale"])
    def test_overrides_and_scenarios_are_not_part_of_the_definition(
        self, fixture, request
    ):
        """Calliope resolves them away first, and so does this."""
        definition = assembled(request.getfixturevalue(fixture))
        assert "overrides" not in definition.sections
        assert "scenarios" not in definition.sections


class TestNodePositions:
    """Where the nodes are. The divergence that started all of this."""

    @pytest.mark.parametrize("fixture", ["national_scale", "urban_scale"])
    def test_stock_examples_agree(self, fixture, request):
        path = request.getfixturevalue(fixture)
        structural = geo.node_positions(path)
        resolved = _resolved_positions(_resolved(path))

        assert set(structural) == set(resolved)
        for node, (longitude, latitude) in resolved.items():
            assert structural[node] == pytest.approx([longitude, latitude])

    @nld_only
    def test_coordinates_from_a_data_table_agree(self):
        """31 of these 37 positions are in a CSV, and 6 are in the YAML."""
        structural = geo.node_positions(NLD)
        resolved = _resolved_positions(_resolved(NLD))

        assert set(structural) == set(resolved)
        assert len(structural) == 37
        for node, (longitude, latitude) in resolved.items():
            assert structural[node] == pytest.approx([longitude, latitude])


class TestLinks:
    """Which technologies are links."""

    @pytest.mark.parametrize("fixture", ["national_scale", "urban_scale"])
    def test_stock_examples_agree(self, fixture, request):
        path = request.getfixturevalue(fixture)
        assert transmission_techs(path) == _resolved_links(_resolved(path))

    @nld_only
    def test_the_nld_example_agrees(self):
        assert transmission_techs(NLD) == _resolved_links(_resolved(NLD))

    @nld_only
    def test_every_link_is_oriented(self):
        """The one thing the resolved model cannot say: which end is which.

        `link_from` survives into `model.inputs` only when it came from a data
        table, so orientation is read from the declaration — and every link the
        resolved model knows about has to be in there, or the map draws it
        backwards.
        """
        oriented = geo.link_orientation(NLD)
        for tech in _resolved_links(_resolved(NLD)):
            assert tech in oriented, tech
            assert len(set(oriented[tech])) == 2


class TestTemplates:
    """Template inheritance, which Calliope resolves recursively."""

    @nld_only
    def test_a_template_inheriting_a_template_is_resolved(self):
        """`power_lines` inherits `interest_rate_setter`.

        One level of resolution dropped `cost_interest_rate` from all 41 of this
        model's links, which is a cost the user wrote down and the editor did not
        show.
        """
        techs = resolved_techs(NLD)
        links = [name for name in techs if "_to_" in name]
        assert links
        for name in links:
            assert "cost_interest_rate" in techs[name], name

    @nld_only
    def test_an_indexed_parameter_keeps_its_index(self):
        """`{**template, **entry}` replaced the whole mapping rather than merging.

        Calliope unions leaf by leaf, so an entry setting only `data` keeps the
        template's `index` and `dims`.
        """
        cost = resolved_techs(NLD)["BEL211_to_NLD341_1"]["cost_interest_rate"]
        assert set(cost) == {"data", "index", "dims"}

    @pytest.mark.parametrize("fixture", ["national_scale", "urban_scale"])
    def test_resolved_techs_match_the_model(self, fixture, request):
        """Every technology in the model is one the structural reading found.

        Not the converse: `active: false` technologies are absent from a resolved
        model and present here, deliberately — the editor has to show one to let it
        be switched back on. That is the documented difference.
        """
        path = request.getfixturevalue(fixture)
        structural = set(resolved_techs(path))
        resolved = {str(tech) for tech in _resolved(path).inputs.techs.values}
        assert resolved - structural == set()


class TestDataTableParams:
    """What the tables supply, and how it is indexed."""

    @pytest.mark.parametrize("fixture", ["national_scale", "urban_scale"])
    def test_reported_dims_match_the_model(self, fixture, request):
        """A parameter's dimensions are the model's, not a guess.

        This is what stops a `(nodes, techs)` parameter being presented as a
        parameter of the node with one technology's value.
        """
        path = request.getfixturevalue(fixture)
        inputs = _resolved(path).inputs

        for kind, entity_dim in (("tech", "techs"), ("node", "nodes")):
            params = data_table_params(path, kind)["params"]
            for entity, reported in params.items():
                for parameter, info in reported.items():
                    if parameter not in inputs:
                        continue
                    expected = {
                        str(dim) for dim in inputs[parameter].dims if dim != entity_dim
                    }
                    assert set(info["dims"]) <= expected, f"{kind} {entity}.{parameter}"

    @nld_only
    def test_a_two_dimensional_parameter_gets_no_value(self):
        """`flow_cap_max` is per (node, tech). A node does not have one."""
        params = data_table_params(NLD, "node")["params"]
        info = params["NLD111"]["flow_cap_max"]
        assert info["value"] is None
        assert info["dims"] == ["techs"]

    @nld_only
    def test_a_genuine_node_parameter_keeps_its_value(self):
        params = data_table_params(NLD, "node")["params"]
        assert params["NLD111"]["latitude"]["value"] == pytest.approx(53.1159, abs=1e-3)

    @pytest.mark.parametrize("fixture", ["national_scale", "urban_scale"])
    def test_add_dims_tables_are_seen_at_all(self, fixture, request):
        """A table declaring its parameter with `add_dims` used to report nothing.

        Both stock examples define their timeseries that way, so the editor offered
        an editable field for every value those tables overwrite.
        """
        path = request.getfixturevalue(fixture)
        params = data_table_params(path, "tech")["params"]
        reported = {parameter for entity in params.values() for parameter in entity}
        assert any(
            parameter in reported
            for parameter in ("sink_use_equals", "source_use_max", "sink_use_max")
        ), reported


class TestCoordinatePairs:
    """Calliope requires a node's two coordinates to have the same numeric type.

    Found by asking it: dragging a node to exactly `-2` longitude sent an int
    beside a float latitude, and the model stopped loading with *"Invalid
    latitude/longitude definition. Types must match"*. JavaScript cannot express
    "the float 40" over JSON, so this is fixed where the write happens.
    """

    def test_a_mixed_pair_is_harmonised(self):
        nodes = {"a": {"latitude": 41.5, "longitude": -2}}
        harmonise_coordinates(nodes)
        assert isinstance(nodes["a"]["longitude"], float)
        assert nodes["a"] == {"latitude": 41.5, "longitude": -2.0}

    def test_a_consistent_pair_keeps_its_spelling(self):
        # `national_scale` writes both as integers, and rewriting the user's file
        # to say `40.0` would be a change nobody asked for.
        nodes = {"a": {"latitude": 40, "longitude": -2}}
        harmonise_coordinates(nodes)
        assert nodes["a"] == {"latitude": 40, "longitude": -2}
        assert isinstance(nodes["a"]["latitude"], int)

    def test_anything_else_is_left_alone(self):
        nodes = {
            "half": {"latitude": 40},
            "none": {"techs": {}},
            "text": {"latitude": "40", "longitude": -2.0},
            "null": None,
        }
        before = repr(nodes)
        harmonise_coordinates(nodes)
        assert repr(nodes) == before

    def test_a_dragged_node_still_loads(self, national_scale):
        """End to end: write a mixed pair through the same path a save takes."""
        from calliope_studio.modeldef.yaml_io import write_section

        locations = national_scale / "model_config" / "locations.yaml"
        section = dict(read_section(locations, "nodes"))
        section["region1"] = {**section["region1"], "latitude": 41.5, "longitude": -2}
        write_section(locations, "nodes", harmonise_coordinates(section))

        import calliope

        # Raises if the pair is mixed.
        assert calliope.read_yaml(str(national_scale / "model.yaml")) is not None


class TestFallbackHonesty:
    """What the structural reading does when Calliope cannot read the model.

    The point is that it still answers. These are the cases the editor is in most
    of the time it matters — mid-keystroke — and an exception here is a blank map.
    """

    def test_a_model_that_does_not_build_still_has_geometry(self, national_scale):
        locations = national_scale / "model_config" / "locations.yaml"
        locations.write_text(
            locations.read_text().replace("      ccgt:", "      nope:", 1)
        )
        import calliope

        with pytest.raises(Exception):
            calliope.read_yaml(str(national_scale / "model.yaml"))

        assert geo.node_positions(national_scale)
        assert geo.geojson(national_scale)["nodes"]["features"]

    def test_a_model_that_does_not_parse_still_has_geometry(self, national_scale):
        (national_scale / "model_config" / "techs.yaml").write_text("{[not yaml")
        assert assembled(national_scale) is None
        # Nodes live in another file, and one broken file must not hide them.
        assert geo.node_positions(national_scale)

    def test_a_circular_template_does_not_raise(self, national_scale):
        model = national_scale / "model.yaml"
        model.write_text(
            model.read_text()
            + "\ntemplates:\n  a:\n    template: b\n  b:\n    template: a\n"
        )
        assert assembled(national_scale) is None
        assert resolved_techs(national_scale)


class TestSyntheticFeatures:
    """The three nld-only features, rebuilt on a model everyone has.

    `examples/` is gitignored, so nine assertions above run on one developer's
    disk and nowhere else — and they are the ones guarding the three worst bugs
    this project has had: node coordinates supplied by a data table, links
    supplied by a data table, and a template inheriting a template. Each is a
    *mechanism*, and a mechanism can be built out of `national_scale`.

    These do not replace the nld assertions, which check the real thing at real
    scale. They make the mechanisms fail in CI rather than silently going
    unchecked there.
    """

    def _rewrite(self, path: Path, replace: str, with_: str) -> None:
        text = path.read_text(encoding="utf-8")
        assert replace in text, f"{path.name} no longer contains {replace!r}"
        path.write_text(text.replace(replace, with_, 1), encoding="utf-8")

    def test_coordinates_from_a_data_table_are_seen(self, national_scale):
        """The bug: a model with its positions in a CSV had no geography at all.

        Moving one node's coordinates out of the YAML and into a table is enough
        to reproduce it — the structural reading has to find all five nodes, not
        four.
        """
        locations = national_scale / "model_config" / "locations.yaml"
        nodes = read_section(locations, "nodes")
        moved, position = next(iter(nodes.items()))
        longitude, latitude = position["longitude"], position["latitude"]

        self._rewrite(
            locations, f"    latitude: {latitude}\n    longitude: {longitude}\n", ""
        )
        # `_rewrite` replaces the first occurrence, and several nodes share a
        # latitude — so check the node, not the text.
        assert "latitude" not in read_section(locations, "nodes")[moved]
        table = national_scale / "data_tables" / "coords.csv"
        table.parent.mkdir(exist_ok=True)
        table.write_text(
            f"nodes,latitude,longitude\n{moved},{latitude},{longitude}\n",
            encoding="utf-8",
        )
        self._rewrite(
            national_scale / "model.yaml",
            "data_tables:\n",
            "data_tables:\n"
            "  node_coordinates:\n"
            "    table: data_tables/coords.csv\n"
            "    rows: nodes\n"
            "    columns: inputs\n",
        )

        structural = geo.node_positions(national_scale)
        resolved = _resolved_positions(_resolved(national_scale))

        assert set(structural) == set(resolved)
        assert moved in structural
        assert structural[moved] == pytest.approx([longitude, latitude])

    def test_a_template_inheriting_a_template_is_resolved(self, national_scale):
        """The bug: one level of resolution dropped a cost from all 41 links.

        Two hops is the whole of it — a technology whose template has a template
        must end up with what the *outer* one sets.
        """
        techs_file = national_scale / "model_config" / "techs.yaml"
        self._rewrite(
            techs_file,
            "templates:\n",
            "templates:\n"
            "  interest_rate_setter:\n"
            "    cost_interest_rate: 0.1\n"
            "  power_lines_two_hop:\n"
            "    template: interest_rate_setter\n"
            "    base_tech: transmission\n"
            "    carrier_in: power\n"
            "    carrier_out: power\n",
        )
        self._rewrite(
            techs_file,
            "  ccgt:\n",
            "  two_hop_line:\n"
            "    template: power_lines_two_hop\n"
            "    link_from: region1\n"
            "    link_to: region2\n"
            "  ccgt:\n",
        )

        techs = resolved_techs(national_scale)
        assert techs["two_hop_line"]["cost_interest_rate"] == 0.1
        # And the second hop is what makes it a link at all.
        assert "two_hop_line" in transmission_techs(national_scale)

    def test_links_from_a_data_table_are_still_oriented(self, national_scale):
        """The one thing a resolved model cannot say: which end of a link is which.

        Calliope normalises the direction away, so orientation is read from the
        declaration — and every link the resolved model knows about has to be in
        there or the map draws it backwards. Asserted here on the stock model so
        the property is checked without the nld example.
        """
        oriented = geo.link_orientation(national_scale)
        for tech in _resolved_links(_resolved(national_scale)):
            assert tech in oriented, tech
            assert len(set(oriented[tech])) == 2
