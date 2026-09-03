"""Workspace path handling and file classification.

`file_type` is answered twice — here, for the tree's icons, and in
`web/src/lib/fileKind.ts`, for which renderer a tab gets. The duplication is
deliberate and explained there: a tab restored from a `?tab=` URL exists before
the file tree has been fetched, so the client cannot wait for this answer.

The two tables therefore have to be kept in step by hand, and this test exists
to be the same table as `fileKind.test.ts`. If you add an extension to one, add
it to both, here and there.
"""

import sys

import pytest

from calliope_studio.modeldef.paths import (
    content_revision,
    file_type,
    walk_files,
    write_text_atomic,
)

#: Kept identical to the table in `web/src/lib/fileKind.test.ts`.
CLASSIFICATIONS = [
    ("model.yaml", "yaml"),
    ("model.yml", "yaml"),
    ("data_tables/costs.csv", "csv"),
    ("README.md", "markdown"),
    ("notes.markdown", "markdown"),
    ("diagram.png", "image"),
    ("photo.JPEG", "image"),
    ("logo.svg", "image"),
    ("results.nc", "binary"),
    ("archive.zip", "binary"),
    ("sheet.xlsx", "binary"),
    ("LICENSE", "other"),
    ("script.py", "other"),
    ("notes.txt", "other"),
]


@pytest.mark.parametrize(("name", "expected"), CLASSIFICATIONS)
def test_file_type(name, expected):
    assert file_type(name) == expected


def test_extension_matching_is_case_insensitive():
    """Real model folders carry `.PNG` and `.CSV` from other tools."""
    assert file_type("A.PNG") == file_type("a.png")


def test_walk_files_lists_an_empty_directory(tmp_path):
    """The reason directories became entries at all.

    A folder used to be inferred from the `/` in the paths of the files under
    it, so one with nothing in it could not be represented — which made "new
    folder" impossible: the folder would be created and then not appear.
    """
    (tmp_path / "empty").mkdir()
    (tmp_path / "full").mkdir()
    (tmp_path / "full" / "model.yaml").write_text("config: {}\n")

    entries = walk_files(tmp_path)
    by_path = {entry["path"]: entry for entry in entries}

    assert by_path["empty"]["type"] == "directory"
    assert by_path["full"]["type"] == "directory"
    assert by_path["full/model.yaml"]["type"] == "yaml"
    assert by_path["full/model.yaml"]["size"] > 0


def test_walk_files_hides_excluded_directories(tmp_path):
    """A directory entry must not reintroduce what the name filter removes."""
    (tmp_path / "calliope-studio" / "runs").mkdir(parents=True)
    (tmp_path / ".git").mkdir()
    (tmp_path / "model.yaml").write_text("config: {}\n")

    paths = {entry["path"] for entry in walk_files(tmp_path)}
    assert paths == {"model.yaml"}


class TestAtomicReplacement:
    """A save replaces the inode, so what the temporary had is what remains."""

    @pytest.mark.skipif(sys.platform == "win32", reason="POSIX permission bits")
    def test_the_original_permissions_survive_a_save(self, tmp_path):
        """`mkstemp` creates 0600, so the first save made a 0644 file private."""
        import os
        import stat

        path = tmp_path / "techs.yaml"
        path.write_text("a: 1\n", encoding="utf-8")
        os.chmod(path, 0o644)

        write_text_atomic(path, "a: 2\n")
        assert stat.S_IMODE(path.stat().st_mode) == 0o644

    @pytest.mark.skipif(sys.platform == "win32", reason="POSIX permission bits")
    def test_a_new_file_gets_what_open_would_have_given_it(self, tmp_path):
        import os
        import stat

        umask = os.umask(0)
        os.umask(umask)
        path = tmp_path / "new.yaml"
        write_text_atomic(path, "a: 1\n")
        assert stat.S_IMODE(path.stat().st_mode) == 0o666 & ~umask


class TestContentRevision:
    def test_follows_the_bytes_not_the_clock(self, tmp_path):
        path = tmp_path / "a.yaml"
        path.write_text("a: 1\n", encoding="utf-8")
        first = content_revision(path)
        path.write_text("a: 1\n", encoding="utf-8")
        assert content_revision(path) == first
        path.write_text("a: 2\n", encoding="utf-8")
        assert content_revision(path) != first

    def test_a_missing_file_has_none(self, tmp_path):
        assert content_revision(tmp_path / "missing") is None
