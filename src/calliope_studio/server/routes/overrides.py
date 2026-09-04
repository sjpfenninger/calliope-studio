"""Editing overrides as a flat list of settings.

Deliberately not served through `yaml-section`. An override is an arbitrary
partial model, and the editor shows it flattened to dotted paths — so writing the
flattened form straight back would restructure the user's file, turning nested
YAML into a wall of dotted keys the first time anything was saved.

Instead the *edit* crosses the wire, not the document: the client sends the
settings it wants an override to have, and `modeldef.overrides` applies them one
path at a time against the structure already in the file. Whichever spelling the
file uses — nested keys, `config.init:` with `mode:` inside, or a single dotted
key — is the one that gets edited.
"""

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from calliope_studio.modeldef.overrides import flatten, set_path, unset_path
from calliope_studio.modeldef.paths import content_revision
from calliope_studio.modeldef.yaml_io import (
    RenameError,
    SectionNotFound,
    from_plain,
    read_section,
    write_section,
)
from calliope_studio.server.deps import (
    check_revision,
    get_resolver,
    get_workspace,
    require_file,
    resolve_path,
    resolve_writable_path,
)
from calliope_studio.server.resolution import Resolver
from calliope_studio.server.storage import Workspace

router = APIRouter(tags=["overrides"])

SECTION = "overrides"


class Setting(BaseModel):
    """One leaf of an override."""

    path: str = Field(min_length=1)
    value: Any = None


class OverrideBody(BaseModel):
    """Every override the file should define, and the settings each one makes.

    The whole section, not one override: renaming and deleting have to be
    expressible, and both are invisible in a per-override payload.
    """

    overrides: dict[str, list[Setting]]
    #: The file's revision when the overrides were read; see `deps.check_revision`.
    revision: str | None = None
    #: `{new: old}` for every override the form renamed; see `yaml_io._rename_keys`.
    #: This was the one section editor still renaming by delete-and-add, and
    #: its entries are the most comment-heavy in a model.
    renames: dict[str, str] = Field(default_factory=dict)


def _unchanged(existing: Any, value: Any) -> bool:
    """Whether a value came back exactly as it went out.

    `True == 1` in Python, so booleans are separated explicitly: turning a `true`
    into a `1` is a real edit to a model definition, not a formatting detail.
    """
    if isinstance(existing, bool) != isinstance(value, bool):
        return False
    return existing == value


@router.get("/versions/{id}/overrides/{file_path:path}")
def get_overrides(
    file_path: str, workspace: Workspace = Depends(get_workspace)
) -> dict:
    """Each override in the file, as the list of settings it makes."""
    path = require_file(resolve_path(workspace, file_path))
    revision = content_revision(path)
    try:
        section = read_section(path, SECTION)
    except SectionNotFound:
        # A file with no `overrides:` block is a perfectly ordinary file, and the
        # editor's answer is an empty list rather than an error.
        return {"overrides": {}, "revision": revision}

    if not isinstance(section, dict):
        return {"overrides": {}, "revision": revision}

    return {
        "overrides": {
            str(name): [
                {"path": setting, "value": value}
                for setting, value in flatten(body).items()
            ]
            for name, body in section.items()
        },
        "revision": revision,
    }


@router.put("/versions/{id}/overrides/{file_path:path}")
def put_overrides(
    file_path: str,
    body: OverrideBody,
    workspace: Workspace = Depends(get_workspace),
    resolver: Resolver = Depends(get_resolver),
) -> dict:
    """Applies the edits, leaving every untouched line exactly as it was.

    A setting that is gone from the payload is unset; one whose value changed is
    set through `set_path`, which resolves against what the file already has.
    Only overrides named in the payload survive, so deleting one is expressible.
    """
    # `resolve_writable_path`, like every other write verb: this was the one
    # that still went through `resolve_path`, so a run's frozen snapshot could
    # be edited through its overrides after every other route had refused.
    path = require_file(resolve_writable_path(workspace, file_path))
    check_revision(path, body.revision)
    try:
        section = read_section(path, SECTION)
    except SectionNotFound:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="This file defines no overrides.",
        ) from None

    existing: dict = section if isinstance(section, dict) else {}
    updated: dict[str, Any] = {}

    for name, settings in body.overrides.items():
        # A renamed override's settings resolve against the block it was, or
        # every dotted key it kept is rebuilt nested from nothing.
        document = existing.get(body.renames.get(name, name))
        document = dict(document) if isinstance(document, dict) else {}
        current = flatten(document)

        wanted = {setting.path: from_plain(setting.value) for setting in settings}
        for gone in [key for key in current if key not in wanted]:
            unset_path(document, gone)
        for setting_path, value in wanted.items():
            # Only what actually changed. A value that survived a JSON round trip
            # is no longer ruamel's object, so assigning it back would rewrite
            # `0.10` as `0.1` and `True` as `true` in settings nobody touched —
            # invisible to a parser, and noise in a diff.
            if setting_path in current and _unchanged(current[setting_path], value):
                continue
            try:
                set_path(document, setting_path, value)
            except ValueError as exc:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
                ) from None

        updated[name] = document

    try:
        write_section(path, SECTION, updated, renames=body.renames)
    except RenameError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from None
    # An override changes what a scenario means; the resolver re-reads the
    # definition after a section write, and this is a section write.
    resolver.refresh(workspace)
    return {"ok": True, "revision": content_revision(path)}
