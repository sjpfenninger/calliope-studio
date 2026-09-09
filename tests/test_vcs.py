"""The `vcs` layer, against real throwaway repositories.

Every test here shells out to git, which makes this the first file in the
suite that has to be hermetic about the developer's own configuration. The
fixture points `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` at files of its
own, so an inherited `commit.gpgsign = true` with a broken helper — the very
hazard the retry in `commit.py` exists for — cannot fail the suite on one
machine only, and the identity every commit needs is written there rather
than assumed.

The cases worth having are the ones where a wrong answer would be quiet: a
nested model folder showing its parent repository's files, an ignored folder
reading as a healthy empty repository, a rename parsed the wrong way round,
and a discard that leaves a staged addition behind.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

from calliope_studio.vcs import commit as commit_module
from calliope_studio.vcs import diff, discard, init, log, repo, status, tree
from calliope_studio.vcs.command import GitError, git_available, run

pytestmark = pytest.mark.skipif(not git_available(), reason="git is not installed")


@pytest.fixture(autouse=True)
def _hermetic(hermetic_git):
    """Every test here shells out to git; see `conftest.hermetic_git`."""
    return hermetic_git


def make_model(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    (path / "model.yaml").write_text("name: test\n", encoding="utf-8")
    (path / "techs.yaml").write_text(
        "techs:\n  ccgt:\n    flow_cap_max: 10\n", encoding="utf-8"
    )
    return path


def make_repo(path: Path) -> repo.Repo:
    return init.init(make_model(path))


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def states(found: list[status.FileStatus]) -> dict[str, str]:
    return {entry.path: entry.state for entry in found}


class TestDiscover:
    def test_a_plain_folder_is_in_no_repository(self, tmp_path):
        assert repo.discover(make_model(tmp_path / "model")) is None

    def test_a_missing_folder_is_in_no_repository(self, tmp_path):
        assert repo.discover(tmp_path / "nowhere") is None

    def test_a_fresh_repository_is_its_own_root(self, tmp_path):
        found = make_repo(tmp_path / "model")
        assert found.root == found.workspace
        assert found.pathspec == "."
        assert found.branch == "main"
        assert not found.nested
        assert not found.ignored
        assert not found.detached
        assert repo.head(found)

    def test_a_nested_folder_is_scoped_by_its_pathspec(self, tmp_path):
        """A model inside a paper's repository must show only its own files."""
        make_repo(tmp_path / "paper")
        model = make_model(tmp_path / "paper" / "models" / "base")
        found = repo.discover(model)
        assert found is not None
        assert found.nested
        assert found.pathspec == "models/base"
        assert found.relative("techs.yaml") == "models/base/techs.yaml"
        assert found.unrelative("models/base/techs.yaml") == "techs.yaml"
        assert found.unrelative("README.md") is None

    def test_an_ignored_folder_says_so(self, tmp_path):
        """The state `pixi run serve` opens: inside a repository, ignored by it.

        Naive "is this a repo?" answers yes here, and every list is then
        empty for ever with nothing to explain why.
        """
        paper = make_repo(tmp_path / "paper")
        write(paper.root / ".gitignore", "scratch/\n")
        model = make_model(paper.root / "scratch" / "model")
        found = repo.discover(model)
        assert found is not None
        assert found.ignored
        assert not found.tracked
        assert status.changes(found) == []

    def test_a_detached_head_is_reported(self, tmp_path):
        found = make_repo(tmp_path / "model")
        sha = repo.head(found)
        run(["checkout", "-q", "--detach", sha], found.root)
        again = repo.discover(found.workspace)
        assert again is not None
        assert again.detached
        assert again.branch == sha[:7]

    @pytest.mark.skipif(sys.platform == "win32", reason="symlinks need privileges")
    def test_a_symlinked_folder_resolves_to_the_real_one(self, tmp_path):
        """`workspace_id` resolves paths, so the pathspec must be computed on
        the same real path git reports, or the two disagree."""
        found = make_repo(tmp_path / "real")
        link = tmp_path / "link"
        os.symlink(found.workspace, link, target_is_directory=True)
        via_link = repo.discover(link)
        assert via_link is not None
        assert via_link.root == found.root
        assert via_link.pathspec == "."


class TestInit:
    def test_writes_an_ignore_file_and_makes_the_first_commit(self, tmp_path):
        found = make_repo(tmp_path / "model")
        ignore = (found.workspace / ".gitignore").read_text(encoding="utf-8")
        assert "*.nc" in ignore
        history = log.log(found)
        assert [entry.subject for entry in history] == [init.INITIAL_MESSAGE]
        assert status.changes(found) == []

    def test_keeps_an_ignore_file_that_is_already_there(self, tmp_path):
        model = make_model(tmp_path / "model")
        write(model / ".gitignore", "mine\n")
        init.init(model)
        assert (model / ".gitignore").read_text(encoding="utf-8") == "mine\n"

    def test_refuses_a_folder_that_is_already_a_repository(self, tmp_path):
        found = make_repo(tmp_path / "model")
        with pytest.raises(init.AlreadyTracked):
            init.init(found.workspace)

    def test_a_nested_folder_may_become_its_own_repository(self, tmp_path):
        """The offer made for a folder its parent repository ignores."""
        paper = make_repo(tmp_path / "paper")
        write(paper.root / ".gitignore", "scratch/\n")
        model = make_model(paper.root / "scratch" / "model")
        found = init.init(model)
        assert found.root == model.resolve()
        assert not found.nested

    def test_without_an_identity_nothing_is_written(self, tmp_path, hermetic_git):
        """Told before, not after: a repository with no first commit has no
        branch and no HEAD, and every later question fails against it."""
        hermetic_git.write_text("", encoding="utf-8")
        model = make_model(tmp_path / "model")
        with pytest.raises(commit_module.IdentityMissing):
            init.init(model)
        assert not (model / ".git").exists()

    def test_the_first_commit_survives_a_broken_signing_helper(
        self, tmp_path, hermetic_git
    ):
        hermetic_git.write_text(
            hermetic_git.read_text(encoding="utf-8")
            + "[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = /nonexistent/gpg\n",
            encoding="utf-8",
        )
        found = make_repo(tmp_path / "model")
        assert repo.head(found)


class TestStatus:
    def test_the_four_plain_states(self, tmp_path):
        found = make_repo(tmp_path / "model")
        write(found.workspace / "techs.yaml", "techs: {}\n")
        write(found.workspace / "notes.md", "# notes\n")
        (found.workspace / "model.yaml").unlink()
        write(found.workspace / "new.yaml", "a: 1\n")
        run(["add", "--", "new.yaml"], found.root)

        assert states(status.changes(found)) == {
            "techs.yaml": "modified",
            "notes.md": "untracked",
            "model.yaml": "deleted",
            "new.yaml": "added",
        }

    def test_a_rename_names_where_the_file_came_from(self, tmp_path):
        found = make_repo(tmp_path / "model")
        (found.workspace / "techs.yaml").rename(found.workspace / "technologies.yaml")
        run(["add", "-A", "--", "."], found.root)
        [entry] = status.changes(found)
        assert entry.state == "renamed"
        assert entry.path == "technologies.yaml"
        assert entry.original == "techs.yaml"

    def test_the_rename_form_is_new_path_then_old(self, tmp_path):
        """`-z` reverses the human format's `old -> new`, and reads plausibly
        either way, so the parser is pinned on fixed text."""
        found = make_repo(tmp_path / "model")
        [entry] = status.parse_porcelain("R  new.yaml\0old.yaml\0", found)
        assert (entry.path, entry.original) == ("new.yaml", "old.yaml")

    def test_a_conflict_is_shown_as_one(self, tmp_path):
        found = make_repo(tmp_path / "model")
        run(["checkout", "-q", "-b", "other"], found.root)
        write(found.workspace / "techs.yaml", "techs: other\n")
        commit_module.commit(found, None, "theirs")
        run(["checkout", "-q", "main"], found.root)
        write(found.workspace / "techs.yaml", "techs: mine\n")
        commit_module.commit(found, None, "mine")
        run(["merge", "other"], found.root, check=False)
        assert states(status.changes(found)) == {"techs.yaml": "conflicted"}

    def test_a_nested_folder_lists_only_its_own_files(self, tmp_path):
        paper = make_repo(tmp_path / "paper")
        model = make_model(paper.root / "models" / "base")
        commit_module.commit(paper, None, "add model")
        write(paper.root / "README.md", "changed\n")
        write(model / "techs.yaml", "techs: {}\n")
        found = repo.discover(model)
        assert states(status.changes(found)) == {"techs.yaml": "modified"}


class TestLog:
    def test_newest_first_with_what_each_commit_changed(self, tmp_path):
        found = make_repo(tmp_path / "model")
        write(found.workspace / "techs.yaml", "techs: {}\n")
        sha = commit_module.commit(found, None, "Tighten techs")

        history = log.log(found)
        assert [entry.subject for entry in history] == [
            "Tighten techs",
            init.INITIAL_MESSAGE,
        ]
        assert history[0].sha == sha
        assert history[0].short == sha[:7]
        assert history[0].author == "Studio Test"
        assert log.commit_files(found, sha) == [
            {"path": "techs.yaml", "state": "modified", "original": None}
        ]

    def test_the_first_commit_lists_everything_as_added(self, tmp_path):
        found = make_repo(tmp_path / "model")
        [root] = log.log(found)
        assert log.parent(found, root.sha) is None
        assert {entry["path"] for entry in log.commit_files(found, root.sha)} == {
            ".gitignore",
            "model.yaml",
            "techs.yaml",
        }

    def test_one_file_has_its_own_history(self, tmp_path):
        found = make_repo(tmp_path / "model")
        write(found.workspace / "techs.yaml", "techs: {}\n")
        commit_module.commit(found, None, "techs only")
        assert [entry.subject for entry in log.log(found, path="model.yaml")] == [
            init.INITIAL_MESSAGE
        ]

    def test_a_commit_carries_its_body(self, tmp_path):
        found = make_repo(tmp_path / "model")
        write(found.workspace / "techs.yaml", "techs: {}\n")
        sha = commit_module.commit(found, None, "Subject\n\nA body.\n")
        info = log.commit_info(found, sha)
        assert info is not None
        assert (info.subject, info.body) == ("Subject", "A body.")
        assert log.commit_info(found, "0" * 40) is None

    def test_a_branch_with_no_commits_has_no_history(self, tmp_path):
        model = make_model(tmp_path / "model")
        run(["init", "-q"], model)
        found = repo.discover(model)
        assert repo.head(found) is None
        assert log.log(found) == []


class TestDiff:
    def test_modify_add_and_delete(self, tmp_path):
        found = make_repo(tmp_path / "model")
        write(found.workspace / "techs.yaml", "techs: {}\n")
        write(found.workspace / "new.yaml", "a: 1\n")
        (found.workspace / "model.yaml").unlink()

        modified = diff.working_diff(found, "techs.yaml")
        assert modified.original.startswith("techs:\n  ccgt")
        assert modified.modified == "techs: {}\n"
        assert modified.original_exists and modified.modified_exists

        added = diff.working_diff(found, "new.yaml")
        assert (added.original, added.modified) == ("", "a: 1\n")
        assert not added.original_exists

        deleted = diff.working_diff(found, "model.yaml")
        assert deleted.original == "name: test\n"
        assert not deleted.modified_exists

    def test_a_binary_file_is_marked_and_not_shown(self, tmp_path):
        found = make_repo(tmp_path / "model")
        (found.workspace / "results.bin").write_bytes(b"\x00\x01\x02")
        found_diff = diff.working_diff(found, "results.bin")
        assert found_diff.binary
        assert found_diff.modified == ""

    def test_a_side_too_large_to_show_is_marked_and_not_sent(
        self, tmp_path, monkeypatch
    ):
        """The same ceiling the editor's own reads apply, for the same reason:
        a hundred-megabyte CSV would be escaped into JSON and handed to
        Monaco. Both sides still say they exist, so the pane can say which
        kind of change it is not showing."""
        found = make_repo(tmp_path / "model")
        monkeypatch.setattr(diff, "MAX_DIFF_BYTES", 8)
        write(found.workspace / "techs.yaml", "techs: {}\n")
        found_diff = diff.working_diff(found, "techs.yaml")
        assert found_diff.truncated
        assert (found_diff.original, found_diff.modified) == ("", "")
        assert found_diff.original_exists and found_diff.modified_exists

    def test_a_commit_is_read_against_its_parent(self, tmp_path):
        found = make_repo(tmp_path / "model")
        write(found.workspace / "techs.yaml", "techs: {}\n")
        sha = commit_module.commit(found, None, "change")
        found_diff = diff.commit_diff(found, sha, "techs.yaml")
        assert found_diff.original.startswith("techs:\n  ccgt")
        assert found_diff.modified == "techs: {}\n"

        [root] = [
            entry for entry in log.log(found) if entry.subject == init.INITIAL_MESSAGE
        ]
        first = diff.commit_diff(found, root.sha, "model.yaml")
        assert not first.original_exists
        assert first.modified == "name: test\n"


class TestCommit:
    def test_everything_under_the_folder(self, tmp_path):
        found = make_repo(tmp_path / "model")
        write(found.workspace / "techs.yaml", "techs: {}\n")
        write(found.workspace / "data" / "demand.csv", "a,b\n1,2\n")
        sha = commit_module.commit(found, None, "Both")
        assert status.changes(found) == []
        assert {entry["path"] for entry in log.commit_files(found, sha)} == {
            "techs.yaml",
            "data/demand.csv",
        }

    def test_only_the_paths_named(self, tmp_path):
        found = make_repo(tmp_path / "model")
        write(found.workspace / "techs.yaml", "techs: {}\n")
        write(found.workspace / "model.yaml", "name: changed\n")
        commit_module.commit(found, ["techs.yaml"], "One of two")
        assert states(status.changes(found)) == {"model.yaml": "modified"}

    def test_nothing_to_commit_is_its_own_failure(self, tmp_path):
        found = make_repo(tmp_path / "model")
        with pytest.raises(commit_module.NothingToCommit):
            commit_module.commit(found, None, "Empty")

    def test_a_blank_message_is_refused_before_git_is_asked(self, tmp_path):
        found = make_repo(tmp_path / "model")
        with pytest.raises(ValueError):
            commit_module.commit(found, None, "   ")

    def test_a_broken_signing_helper_is_retried_unsigned(self, tmp_path, hermetic_git):
        found = make_repo(tmp_path / "model")
        hermetic_git.write_text(
            hermetic_git.read_text(encoding="utf-8")
            + "[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = /nonexistent/gpg\n",
            encoding="utf-8",
        )
        write(found.workspace / "techs.yaml", "techs: {}\n")
        assert commit_module.commit(found, None, "Unsigned")
        assert status.changes(found) == []

    def test_any_other_failure_is_not_masked(self, tmp_path, hermetic_git):
        """Only a signing failure is retried; a hook that says no stays no."""
        found = make_repo(tmp_path / "model")
        hook = found.root / ".git" / "hooks" / "pre-commit"
        hook.write_text("#!/bin/sh\necho refused >&2\nexit 1\n", encoding="utf-8")
        hook.chmod(0o755)
        write(found.workspace / "techs.yaml", "techs: {}\n")
        if sys.platform == "win32":
            pytest.skip("hooks need a POSIX shell")
        with pytest.raises(GitError) as caught:
            commit_module.commit(found, None, "Hooked")
        assert "refused" in caught.value.stderr

    def test_a_missing_identity_is_named(self, tmp_path, hermetic_git):
        found = make_repo(tmp_path / "model")
        hermetic_git.write_text("", encoding="utf-8")
        write(found.workspace / "techs.yaml", "techs: {}\n")
        with pytest.raises(commit_module.IdentityMissing):
            commit_module.commit(found, None, "Who")


class TestDiscard:
    def test_a_modified_file_goes_back_to_head(self, tmp_path):
        found = make_repo(tmp_path / "model")
        write(found.workspace / "techs.yaml", "techs: {}\n")
        discard.discard(found, "techs.yaml")
        assert (
            (found.workspace / "techs.yaml")
            .read_text(encoding="utf-8")
            .startswith("techs:\n  ccgt")
        )
        assert status.changes(found) == []

    def test_an_untracked_file_is_removed(self, tmp_path):
        found = make_repo(tmp_path / "model")
        write(found.workspace / "notes.md", "x\n")
        discard.discard(found, "notes.md")
        assert not (found.workspace / "notes.md").exists()

    def test_a_staged_addition_is_removed_from_index_and_disk(self, tmp_path):
        """`checkout -- path` alone leaves a staged file exactly where it was."""
        found = make_repo(tmp_path / "model")
        write(found.workspace / "new.yaml", "a: 1\n")
        run(["add", "--", "new.yaml"], found.root)
        discard.discard(found, "new.yaml")
        assert not (found.workspace / "new.yaml").exists()
        assert status.changes(found) == []

    def test_a_deleted_file_comes_back(self, tmp_path):
        found = make_repo(tmp_path / "model")
        (found.workspace / "model.yaml").unlink()
        discard.discard(found, "model.yaml")
        assert (found.workspace / "model.yaml").is_file()


class TestTree:
    def test_a_nested_folder_is_rooted_at_itself(self, tmp_path):
        """`git archive <sha>:<pathspec>`, not `<sha> -- <pathspec>`: the latter
        keeps the parent's path prefix, so the tree would be rooted at the
        repository and a reader looking for `model.yaml` at the top would find
        nothing. The common case, since a model inside a paper's repository is
        what the pathspec exists for."""
        paper = make_repo(tmp_path / "paper")
        write(paper.root / "README.md", "paper\n")
        model = make_model(paper.root / "models" / "base")
        commit_module.commit(paper, None, "add model")
        found = repo.discover(model)
        sha = repo.head(found)

        dest = tree.materialise(found, sha, tmp_path / "trees" / sha)

        assert (dest / "model.yaml").is_file()
        assert (dest / "techs.yaml").is_file()
        assert not (dest / "README.md").exists()
        assert not (dest / "models").exists()
        assert (dest / tree.MARKER).read_text(encoding="utf-8") == sha

    def test_a_tree_is_extracted_once(self, tmp_path):
        """A commit is immutable, so a tree that is there is the answer."""
        found = make_repo(tmp_path / "model")
        sha = repo.head(found)
        dest = tree.materialise(found, sha, tmp_path / "trees" / sha)
        (dest / "model.yaml").write_text("tampered\n", encoding="utf-8")
        tree.materialise(found, sha, dest)
        assert (dest / "model.yaml").read_text(encoding="utf-8") == "tampered\n"

    def test_an_unknown_commit_leaves_nothing_behind(self, tmp_path):
        found = make_repo(tmp_path / "model")
        dest = tmp_path / "trees" / "none"
        with pytest.raises(GitError):
            tree.materialise(found, "0" * 40, dest)
        assert not dest.exists()
        assert (
            not any((tmp_path / "trees").iterdir())
            if (tmp_path / "trees").exists()
            else True
        )
