"""What a rendering may be filed under, and what must move the key.

Rendering math is four to eight seconds, so it is kept between sessions. The key
is the entire safety argument: it has to move whenever the notation would, and
stay still whenever it would not. Both halves are asserted here, because getting
either wrong is invisible on screen — a key that moves too easily is a cache that
never hits, and one that does not move enough shows one model's equations for
another, which looks exactly like correct math.

The case driving the shape of the key is `available_area`: `urban_scale` sets it
per node and `national_scale` sets it once, so the same base constraint renders
`\\textit{available\\_area}_\\text{node}` in one and `\\textit{available\\_area}`
in the other. Twenty-eight of the components the two models share differ that way.
Nothing about the math files says so; only the shape of the inputs does.
"""

import json
import os
from pathlib import Path

import pytest

from calliope_studio.runs import mathcache

#: Enough of a payload to be stored and read back. The store does not care what
#: is in one beyond `priority`, which it records so the directory is legible.
PAYLOAD = {
    "mode": "base",
    "priority": [{"name": "base", "kind": "builtin"}],
    "objective": "min_cost_optimisation",
    "groups": [],
}


def read_model(root: Path):
    """The model as the worker has it: read from the definition on disk."""
    import calliope

    return calliope.read_yaml(str(root / "model.yaml"))


@pytest.fixture
def baseline(national_scale: Path):
    """`national_scale`, unedited, and its key."""
    model = read_model(national_scale)
    return model, mathcache.fingerprint(model)


class TestFingerprint:
    def test_the_same_model_gives_the_same_key(self, baseline):
        model, key = baseline

        assert mathcache.fingerprint(model) == key
        assert len(key) == 16

    def test_a_resolved_model_matches_the_definition_it_came_from(
        self, baseline, tmp_path
    ):
        """The one that decides whether any of this works.

        The worker fingerprints a model from `calliope.read_yaml`; the server
        fingerprints one read back out of `resolved.nc`, which is where a
        resolution lives. If those two disagreed, every lookup would miss and
        every rendering would be stored under a name nothing ever asks for — a
        cache that costs disk and saves nothing, with no symptom but the eight
        seconds still being there.
        """
        import calliope

        model, key = baseline
        artefact = tmp_path / "resolved.nc"
        model.to_netcdf(str(artefact))

        assert mathcache.fingerprint(calliope.read_netcdf(str(artefact))) == key

    def test_moving_a_parameter_to_a_node_changes_the_key(
        self, baseline, national_scale
    ):
        """The `available_area` case, reproduced.

        `flow_out_eff` is a technology's own property in `national_scale`, so it
        renders unsubscripted. Setting it on one node makes it `(nodes, techs)`,
        and every equation referring to it grows a subscript — while every math
        file in the model is untouched.
        """
        _, key = baseline
        locations = national_scale / "model_config" / "locations.yaml"
        locations.write_text(
            locations.read_text().replace(
                "        flow_cap_max: 30000",
                "        flow_cap_max: 30000\n        flow_out_eff: 0.6",
                1,
            )
        )

        assert mathcache.fingerprint(read_model(national_scale)) != key

    def test_an_edit_that_cannot_change_the_payload_does_not_move_the_key(
        self, baseline, national_scale
    ):
        """The win, stated as a test.

        A comment is the ordinary content of an editing session and cannot
        reach the payload. The mtime fingerprint the tab's staleness warning
        uses moves for it, which is why that one cannot be the cache key.
        """
        _, key = baseline
        techs = national_scale / "model_config" / "techs.yaml"
        techs.write_text(techs.read_text() + "\n# a note to self\n")

        assert mathcache.fingerprint(read_model(national_scale)) == key

    def test_a_changed_value_moves_the_key(self, baseline, national_scale):
        """The values are in the key because the payload reads them.

        A changed number used to share an entry — the notation reads only
        dims — until `mathdoc` started marking a component whose `where`
        matches nothing as `unmatched`, which is decided from the values. Two
        models sharing an entry on dims alone were served each other's
        labelling: a constraint that binds marked as having nothing to bind
        to, or the reverse.
        """
        _, key = baseline
        # A node-level value: the tech-level `flow_cap_max: 40000` in
        # `techs.yaml` is shadowed by this one in the resolved inputs, so an
        # edit to it would be invisible to Calliope and to the key alike.
        locations = national_scale / "model_config" / "locations.yaml"
        locations.write_text(
            locations.read_text().replace("flow_cap_max: 30000", "flow_cap_max: 31000")
        )

        assert mathcache.fingerprint(read_model(national_scale)) != key

    def test_enabling_a_math_file_changes_the_key(self, baseline, national_scale):
        """Declaring and enabling are two acts, and only the second is math.

        See `modeldef.mathdef`. This asserts the half that reaches the renderer.
        """
        _, key = baseline
        (national_scale / "custom_math.yaml").write_text(
            "constraints:\n"
            "  my_flow_cap_limit:\n"
            "    description: A constraint that exists only in this test.\n"
            "    foreach: [nodes, techs, carriers]\n"
            "    where: flow_cap_max\n"
            "    equations:\n"
            "      - expression: flow_cap <= flow_cap_max\n"
        )
        model_yaml = national_scale / "model.yaml"
        model_yaml.write_text(
            model_yaml.read_text().replace(
                "    mode: base",
                "    mode: base\n"
                "    math_paths: {my_math: custom_math.yaml}\n"
                "    extra_math: [my_math]",
            )
        )

        assert mathcache.fingerprint(read_model(national_scale)) != key

    def test_the_payload_version_is_part_of_the_key(self, baseline, monkeypatch):
        """Everything else in the key describes what the *backend* reads.

        None of it moves when `mathdoc.render` changes what it builds out of
        that backend — so without this, an entry written by an older Calliope
        Studio is served to a newer one that expects a different shape. Listing
        deactivated components was the change that first needed it.
        """
        model, key = baseline
        monkeypatch.setattr(mathcache, "PAYLOAD_VERSION", mathcache.PAYLOAD_VERSION + 1)

        assert mathcache.fingerprint(model) != key

    def test_the_calliope_version_is_part_of_the_key(self, baseline, monkeypatch):
        """Two versions must never share an entry.

        The renderer changes without the math changing — the jinja templates, the
        escaping filters, the format of a subscript are all Calliope's. This is
        also what lets several Calliope versions coexist in one cache directory,
        which a developer tracking 0.7 is permanently in the middle of.
        """
        import calliope

        model, key = baseline
        monkeypatch.setattr(calliope, "__version__", "0.7.0.dev999")

        assert mathcache.fingerprint(model) != key


class TestStore:
    def test_a_stored_payload_comes_back(self, tmp_path):
        mathcache.write(tmp_path, "abc123", PAYLOAD, model_name="national_scale")

        assert mathcache.read(tmp_path, "abc123") == PAYLOAD

    def test_an_entry_says_which_calliope_it_came_from(self, tmp_path):
        """Inside the entry, not only folded into a digest nothing can invert.

        Somebody looking at the directory wondering what it is and why it is that
        size can answer both by reading one file.
        """
        import calliope

        mathcache.write(tmp_path, "abc123", PAYLOAD, model_name="national_scale")
        entry = json.loads((tmp_path / "abc123.json").read_text())

        assert entry["calliope_version"] == calliope.__version__
        assert entry["model_name"] == "national_scale"
        assert entry["math_sources"] == ["base"]

    def test_an_unknown_key_is_a_miss(self, tmp_path):
        assert mathcache.read(tmp_path, "nothing-here") is None

    def test_a_corrupt_entry_is_a_miss_rather_than_a_failure(self, tmp_path):
        """A bad cache entry must cost a render, never a broken Math tab.

        Truncation is the realistic way to get one — a full disk, or a machine
        that went down mid-write — and the caller's miss path already does the
        right thing.
        """
        (tmp_path / "abc123.json").write_text('{"payload": {"groups": [')

        assert mathcache.read(tmp_path, "abc123") is None

    def test_writing_into_a_directory_that_does_not_exist_yet(self, tmp_path):
        """The cache is created by its first write, not by being asked where it is."""
        directory = tmp_path / "math-cache"

        mathcache.write(directory, "abc123", PAYLOAD)

        assert mathcache.read(directory, "abc123") == PAYLOAD

    def test_pruning_keeps_the_most_recently_read(self, tmp_path):
        """Eviction is by use, not by age of writing.

        A model somebody opens every morning would otherwise be evicted by an
        afternoon spent in other people's, and the entry that gets thrown away is
        the one most likely to be wanted tomorrow.
        """
        for index, key in enumerate(["oldest", "middle", "newest"]):
            mathcache.write(tmp_path, key, PAYLOAD)
            stamp = 1_600_000_000 + index
            os.utime(tmp_path / f"{key}.json", (stamp, stamp))

        mathcache.read(tmp_path, "oldest")
        mathcache.prune(tmp_path, keep=2)

        assert mathcache.read(tmp_path, "oldest") == PAYLOAD
        assert mathcache.read(tmp_path, "newest") == PAYLOAD
        assert mathcache.read(tmp_path, "middle") is None

    def test_pruning_an_absent_directory_is_not_an_error(self, tmp_path):
        mathcache.prune(tmp_path / "never-written", keep=4)


class _Resolved:
    """Stands in for the resolver, which is asked for two things.

    Producing a fresh model is the `Resolver`'s own job and its own subprocess;
    what is under test here is what the route does once it has one.

    `get` answers with the reader's `LoadedModel` in production, and
    `calliope_model` with a real `calliope.Model` — the math path needs the
    pydantic `math` and `config` that only Calliope builds. The stub hands the
    same object to both, because these tests are given a real model and the
    distinction they exercise is the route's, not the reader's.
    """

    def __init__(self, model, source: str) -> None:
        self._model = model
        self._source = source

    def get(self, workspace, **_):
        from calliope_studio.server.resolution import Resolution

        return Resolution(self._source, self._model)

    def calliope_model(self, workspace):
        from calliope_studio.server.resolution import SOURCE_RESOLVED

        # Only ever reached on a resolved source; a stale one is refused before
        # this, which `test_a_stale_resolution_is_never_used_as_a_key` asserts.
        return self._model if self._source == SOURCE_RESOLVED else None


class TestServingAStoredRendering:
    """`routes.math._from_disk`: the path that replaces the subprocess."""

    def test_a_stored_rendering_comes_back_with_no_task_to_poll(
        self, national_scale, storage
    ):
        from calliope_studio.server.resolution import SOURCE_RESOLVED
        from calliope_studio.server.routes import math as route

        model = read_model(national_scale)
        mathcache.write(storage.math_cache_dir(), mathcache.fingerprint(model), PAYLOAD)
        workspace = storage.open(national_scale)

        answer = route._from_disk(
            workspace, storage, _Resolved(model, SOURCE_RESOLVED), "digest"
        )

        assert answer is not None
        assert answer["status"] == "done"
        assert answer["task_id"] is None
        assert answer["result"] == PAYLOAD

    def test_a_hit_still_reports_a_check_the_data_fails(
        self, national_scale, storage, monkeypatch
    ):
        """Why a hit is not simply the stored payload.

        Calliope's `all_or_nothing_lat_lon` check is about the *values*, and
        a stored rendering says nothing about them: whatever the key covers,
        the hit path owes the user what a render would have raised, so
        `mathdoc.check_inputs` runs on it. The key is pinned here so the
        broken model *is* a hit — the values now move the key, which would
        otherwise turn this into a test of a miss.
        """
        from calliope_studio.server.resolution import SOURCE_RESOLVED
        from calliope_studio.server.routes import math as route

        healthy = read_model(national_scale)
        key = mathcache.fingerprint(healthy)
        mathcache.write(storage.math_cache_dir(), key, PAYLOAD)

        locations = national_scale / "model_config" / "locations.yaml"
        locations.write_text(
            locations.read_text().replace("    latitude: 40\n    longitude: -8\n", "")
        )
        broken = read_model(national_scale)
        monkeypatch.setattr(mathcache, "fingerprint", lambda model: key)

        answer = route._from_disk(
            storage.open(national_scale),
            storage,
            _Resolved(broken, SOURCE_RESOLVED),
            "digest",
        )

        assert answer is not None
        assert answer["result"] is None
        assert "latitude and longitude" in answer["error"]

    def test_a_stale_resolution_is_never_used_as_a_key(self, national_scale, storage):
        """It was built from an earlier state of the files.

        Its key names the notation of a model that is no longer on disk, so a hit
        on it would serve the right answer to the wrong question. Rendering is
        what a miss costs, and that is the correct price.
        """
        from calliope_studio.server.resolution import SOURCE_STALE
        from calliope_studio.server.routes import math as route

        model = read_model(national_scale)
        mathcache.write(storage.math_cache_dir(), mathcache.fingerprint(model), PAYLOAD)

        answer = route._from_disk(
            storage.open(national_scale),
            storage,
            _Resolved(model, SOURCE_STALE),
            "digest",
        )

        assert answer is None
