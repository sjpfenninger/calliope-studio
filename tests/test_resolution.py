"""The resolver: what it answers, and how honestly it degrades.

This is mechanism two of "structure and meaning" — everything needing a whole
model (`definition_matrix`, effective values, `active:`) comes through here, and
so does the `resolved | stale | structural` contract the map, the math tab and
`/geo/` all read. It was the least-tested module in `src/` and had no test file
at all, which is a poor match for how much rests on it.

The subprocess is not exercised here: `tests/test_runs.py` covers the worker, and
a real resolve is seconds per case. What is covered is the state machine around
it — which answer comes back, when a resolve is and is not started, and what the
degradation actually promises.
"""

import shutil
from pathlib import Path
from types import SimpleNamespace

import pytest

from calliope_studio.server import resolution
from calliope_studio.server.resolution import (
    MAX_VARIANT_ENTRIES,
    SOURCE_RESOLVED,
    SOURCE_STALE,
    SOURCE_STRUCTURAL,
    Resolution,
    Resolver,
    fingerprint,
    variant_key,
)
from calliope_studio.server.storage import LocalStorage


@pytest.fixture
def workspace(national_scale: Path, storage: LocalStorage):
    return storage.open(national_scale)


@pytest.fixture
def resolver(storage: LocalStorage):
    """A resolver whose `_start` records rather than launching a subprocess."""

    class Runs:
        def __init__(self):
            self.started = []

        def start_task(self, *args, **kwargs):  # pragma: no cover - not reached
            raise AssertionError("the test resolver must not launch a worker")

    return Resolver(runs=Runs(), storage=storage)


class TestFingerprint:
    """What counts as the model having changed.

    `snapshot.collect` is reused because it already answers "every file this
    model needs" — the data-table CSVs and `config.init.math_paths` included,
    neither of which the import graph can see and both of which change what the
    model means without touching a YAML key.
    """

    def test_a_data_table_csv_is_part_of_it(self, national_scale):
        before = fingerprint(national_scale)
        table = national_scale / "data_tables" / "costs.csv"
        table.write_text(table.read_text(encoding="utf-8") + "\n", encoding="utf-8")
        assert fingerprint(national_scale) != before

    def test_a_yaml_edit_is_part_of_it(self, national_scale):
        before = fingerprint(national_scale)
        target = national_scale / "model.yaml"
        target.write_text(
            target.read_text(encoding="utf-8") + "\n# touched\n", encoding="utf-8"
        )
        assert fingerprint(national_scale) != before

    def test_a_file_that_only_changed_size_is_seen(self, national_scale, monkeypatch):
        """Size as well as mtime: an editor can write twice inside one tick."""
        target = national_scale / "model.yaml"
        before = fingerprint(national_scale)
        stat = target.stat()
        target.write_text(
            target.read_text(encoding="utf-8") + "# a\n", encoding="utf-8"
        )
        import os

        os.utime(target, ns=(stat.st_atime_ns, stat.st_mtime_ns))
        assert fingerprint(national_scale) != before

    def test_reading_it_twice_with_no_edit_agrees(self, national_scale):
        assert fingerprint(national_scale) == fingerprint(national_scale)

    def test_a_missing_file_is_recorded_rather_than_raised(self, national_scale):
        """A model mid-edit can name a file that is not there yet."""
        shutil.rmtree(national_scale / "data_tables")
        assert fingerprint(national_scale)


class TestTheDegradationContract:
    """`resolved | stale | structural`, which the whole frontend reads."""

    def test_a_model_never_resolved_is_structural(self, resolver, workspace):
        answer = resolver.get(workspace, start=False)
        assert answer.source == SOURCE_STRUCTURAL
        assert answer.model is None
        assert not answer.is_resolved

    def test_a_workspace_with_no_model_yaml_starts_nothing(
        self, resolver, storage, tmp_path
    ):
        """`_resolvable` is what keeps a folder that is not a model out of the
        worker queue — otherwise every browse would launch a doomed subprocess."""
        empty = tmp_path / "not-a-model"
        empty.mkdir()
        answer = resolver.get(storage.open(empty))
        assert answer.source == SOURCE_STRUCTURAL
        assert answer.task_id is None

    def test_refresh_on_an_unresolvable_workspace_returns_none(
        self, resolver, storage, tmp_path
    ):
        empty = tmp_path / "still-not-a-model"
        empty.mkdir()
        assert resolver.refresh(storage.open(empty)) is None

    def test_a_failed_fingerprint_is_not_retried_on_every_request(
        self, resolver, workspace, monkeypatch
    ):
        """Otherwise a model that does not load starts a subprocess per request,
        and the editor is where a model does not load."""
        starts = []
        monkeypatch.setattr(
            Resolver, "_start", lambda self, entry, ws, current: starts.append(current)
        )
        resolver.get(workspace)
        assert len(starts) == 1

        entry = resolver._entries[(workspace.id, "")]
        entry.failed_fingerprint = fingerprint(workspace.path)
        entry.task_id = None
        resolver.get(workspace)
        assert len(starts) == 1

    def test_a_save_makes_the_previous_failure_no_longer_the_last_word(
        self, resolver, workspace, monkeypatch
    ):
        starts = []
        monkeypatch.setattr(
            Resolver, "_start", lambda self, entry, ws, current: starts.append(current)
        )
        entry = resolver._entries.setdefault((workspace.id, ""), resolution._Entry())
        entry.failed_fingerprint = fingerprint(workspace.path)

        resolver.refresh(workspace)
        assert len(starts) == 1

    def test_forgetting_a_workspace_drops_its_entry(self, resolver, workspace):
        resolver.get(workspace, start=False)
        assert any(key[0] == workspace.id for key in resolver._entries)
        resolver.forget(workspace.id)
        assert not any(key[0] == workspace.id for key in resolver._entries)

    def test_forgetting_one_that_was_never_seen_is_not_an_error(self, resolver):
        resolver.forget("never-heard-of-it")


class TestWhatAResponseCarries:
    """`as_dict` is the payload every consumer of `/geo/` and the math tab reads."""

    def test_a_clean_resolution_says_only_its_source(self):
        assert Resolution(SOURCE_RESOLVED, object()).as_dict() == {"source": "resolved"}

    def test_the_model_itself_is_never_in_the_payload(self):
        payload = Resolution(SOURCE_RESOLVED, object()).as_dict()
        assert list(payload) == ["source"]

    def test_a_resolve_in_flight_is_advertised_so_the_client_can_poll(self):
        payload = Resolution(SOURCE_STALE, object(), task_id="abc").as_dict()
        assert payload == {"source": "stale", "resolve_task": "abc"}

    def test_calliopes_own_complaint_is_surfaced(self):
        """Usually the actual problem with the user's model, so it is not eaten."""
        payload = Resolution(SOURCE_STRUCTURAL, None, error="bad node").as_dict()
        assert payload["resolve_error"] == "bad node"

    def test_only_resolved_claims_to_be_resolved(self):
        assert Resolution(SOURCE_RESOLVED, object()).is_resolved
        assert not Resolution(SOURCE_STALE, object()).is_resolved
        assert not Resolution(SOURCE_STRUCTURAL, None).is_resolved


class TestPruning:
    """Old artefacts go, and a directory that vanishes under the sort does not 500."""

    def test_a_directory_removed_mid_prune_is_survived(self, resolver, tmp_path):
        """`prune` runs from any `/geo/` request, so two can race — and the sort
        used to `stat` a directory the other had just removed."""
        root = tmp_path / "resolutions"
        root.mkdir()
        vanished = root / "gone"
        vanished.mkdir()
        assert resolution._mtime_or_zero(vanished) > 0

        shutil.rmtree(vanished)
        assert resolution._mtime_or_zero(vanished) == 0.0


class TestVariants:
    """One model definition means different things under different scenarios.

    The compare view resolves the current model *under a run's own scenario*, so
    that comparing a run against the working tree shows what the files changed
    rather than what the scenario does. That means the resolver holds more than
    one resolution per workspace, and the risk is that they contaminate each
    other: the editor's own reading is the default variant and must never be
    answered with a scenario applied.
    """

    def test_a_scenario_is_resolved_separately_from_the_model_as_written(
        self, resolver, workspace, monkeypatch
    ):
        started = []
        monkeypatch.setattr(
            Resolver,
            "_start",
            lambda self, entry, ws, current: started.append(entry.variant),
        )
        resolver.get(workspace)
        resolver.get(workspace, variant=("cold_fusion", {}))

        assert started == [(None, {}), ("cold_fusion", {})]
        assert len(resolver._entries) == 2

    def test_the_worker_is_told_which_scenario_to_apply(
        self, resolver, workspace, monkeypatch
    ):
        """The whole mechanism, end to end: it has to reach the `RunRequest`."""
        requests = []

        class Recording:
            def start(self, directory, request, **kwargs):
                requests.append(request)
                return SimpleNamespace(id="task-1")

        monkeypatch.setattr(resolver, "_runs", Recording())
        resolver.get(workspace, variant=("cold_fusion", {"config.init.name": "x"}))

        (request,) = requests
        assert request.scenario == "cold_fusion"
        assert request.override_dict == {"config.init.name": "x"}
        assert request.init_only is True

    def test_the_editors_own_reading_is_never_a_variant(
        self, resolver, workspace, monkeypatch
    ):
        """`calliope_model` feeds the math tab, which is about the model as written."""
        monkeypatch.setattr(Resolver, "_start", lambda *args: None)
        resolver.get(workspace, variant=("cold_fusion", {}))
        assert resolver.calliope_model(workspace) is None

    def test_a_variant_key_ignores_the_order_of_an_override_dict(self):
        """Two dicts differing only in key order are one request to Calliope."""
        assert variant_key(None, {"a": 1, "b": 2}) == variant_key(
            None, {"b": 2, "a": 1}
        )
        assert variant_key(None, {}) == variant_key(None, None) == ""
        assert variant_key("s", {}) != ""

    def test_a_save_drops_the_variants_rather_than_rebuilding_them(
        self, resolver, workspace, monkeypatch
    ):
        """They describe files that have just changed, and nothing is watching them.

        Rebuilding every scenario anybody has ever compared, on every keystroke,
        is a subprocess per scenario per save; the next compare request resolves
        the one variant it actually wants.
        """
        monkeypatch.setattr(Resolver, "_start", lambda *args: None)
        resolver.get(workspace)
        resolver.get(workspace, variant=("cold_fusion", {}))
        assert len(resolver._entries) == 2

        resolver.refresh(workspace)

        assert list(resolver._entries) == [(workspace.id, "")]

    def test_only_so_many_variants_are_kept(self, resolver, workspace, monkeypatch):
        """Each one pins a `.nc`; a session comparing many must not pin them all."""
        monkeypatch.setattr(Resolver, "_start", lambda *args: None)
        for index in range(MAX_VARIANT_ENTRIES + 3):
            resolver.get(workspace, variant=(f"scenario_{index}", {}))
        resolver.get(workspace)

        variants = [key for key in resolver._entries if key[1]]
        assert len(variants) == MAX_VARIANT_ENTRIES
        # The default is never evicted: the editor reads it on every keystroke.
        assert (workspace.id, "") in resolver._entries

    def test_the_least_recently_asked_for_variant_goes_first(
        self, resolver, workspace, monkeypatch
    ):
        monkeypatch.setattr(Resolver, "_start", lambda *args: None)
        for index in range(MAX_VARIANT_ENTRIES):
            resolver.get(workspace, variant=(f"scenario_{index}", {}))
        oldest = (workspace.id, variant_key("scenario_0", {}))
        # Asking again makes it the newest, so the next eviction takes another.
        resolver.get(workspace, variant=("scenario_0", {}))
        resolver.get(workspace, variant=("scenario_new", {}))

        assert oldest in resolver._entries
        assert (workspace.id, variant_key("scenario_1", {})) not in resolver._entries

    def test_forgetting_a_workspace_drops_every_variant_of_it(
        self, resolver, workspace, monkeypatch
    ):
        monkeypatch.setattr(Resolver, "_start", lambda *args: None)
        resolver.get(workspace)
        resolver.get(workspace, variant=("cold_fusion", {}))

        resolver.forget(workspace.id)

        assert resolver._entries == {}
