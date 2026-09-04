"""Comparing two versions of one model: its files, and what they mean."""

from fastapi import APIRouter, Depends, HTTPException, Query, status

from calliope_studio.modeldef.schema import component_units
from calliope_studio.results.diff import model_diff
from calliope_studio.runs.manager import RunManager
from calliope_studio.server import compare
from calliope_studio.server.deps import get_resolver, get_runs, get_workspace
from calliope_studio.server.resolution import Resolver
from calliope_studio.server.storage import Workspace

router = APIRouter(tags=["compare"])


def _sides(
    a: str, b: str, workspace: Workspace, runs: RunManager
) -> tuple[compare.Side, compare.Side]:
    """Both sides, or the first honest complaint about either.

    A malformed reference is a 400 and a missing run a 404, so a bookmarked
    comparison of a run that has since been pruned says which of the two it is.
    """
    try:
        refs = (compare.parse_ref(a), compare.parse_ref(b))
    except compare.BadRef as problem:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(problem)
        ) from None
    sides = []
    for ref in refs:
        try:
            sides.append(compare.side_for(ref, workspace, runs))
        except compare.SideNotFound as problem:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail=str(problem)
            ) from None
        except compare.SideUnavailable as problem:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail=str(problem)
            ) from None
    return sides[0], sides[1]


@router.get("/versions/{id}/compare/")
def get_compare(
    a: str = Query(...),
    b: str = Query(...),
    workspace: Workspace = Depends(get_workspace),
    runs: RunManager = Depends(get_runs),
) -> dict:
    """Which files each side refers to, and how they differ."""
    left, right = _sides(a, b, workspace, runs)
    files = compare.files_diff(left, right)
    return {
        "a": left.descriptor(),
        "b": right.descriptor(),
        "files": files,
        "identical": all(entry["status"] == "unchanged" for entry in files),
        # Two scenarios of one folder read the same bytes, so an empty file
        # list there means something different from two trees that agree.
        "same_root": left.root == right.root,
    }


@router.get("/versions/{id}/compare/file/")
def get_compare_file(
    a: str = Query(...),
    b: str = Query(...),
    path: str = Query(...),
    workspace: Workspace = Depends(get_workspace),
    runs: RunManager = Depends(get_runs),
) -> dict:
    """One file, as each side has it."""
    left, right = _sides(a, b, workspace, runs)
    try:
        return compare.file_pair(left, right, path)
    except compare.SideNotFound as problem:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=str(problem)
        ) from None


@router.get("/versions/{id}/compare/model/")
def get_compare_model(
    a: str = Query(...),
    b: str = Query(...),
    workspace: Workspace = Depends(get_workspace),
    resolver: Resolver = Depends(get_resolver),
    runs: RunManager = Depends(get_runs),
) -> dict:
    """What the two versions mean, according to Calliope.

    Answers 200 while a side is still being resolved rather than making the
    client distinguish "not ready" from "went wrong": reading a model is a
    subprocess taking seconds, the side descriptor carries the task to poll,
    and the files half of the view is already on screen by then.
    """
    left, right = _sides(a, b, workspace, runs)
    models = [compare.model_for(side, workspace, resolver) for side in (left, right)]
    payload = {"a": left.descriptor(), "b": right.descriptor()}

    if any(model is None for model in models):
        pending = [
            side for side in (left, right) if side.model_source.get("resolve_task")
        ]
        return {
            **payload,
            "available": False,
            "pending": bool(pending),
            "reason": _reason(left, right),
        }
    return {
        **payload,
        "available": True,
        "pending": False,
        "diff": model_diff(models[0], models[1], component_units()),
    }


def _reason(a: compare.Side, b: compare.Side) -> str | None:
    """Why there is no comparison to show, in the words of whoever knows.

    Calliope's own complaint where there is one: it is almost always the actual
    problem with the user's model, and a generic message in front of it would
    be one more thing between them and the line to fix.
    """
    for side in (a, b):
        source = side.model_source
        if source.get("source") == compare.SOURCE_UNAVAILABLE:
            return source.get("reason") or source.get("resolve_error")
    return None
