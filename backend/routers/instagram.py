"""
POST /api/instagram/bulk-import   — start a bulk import job
GET  /api/instagram/bulk-import/status — poll progress
DELETE /api/instagram/bulk-import — cancel (mark idle)
"""
import asyncio
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import get_db
from services.instagram_scraper import run_bulk_import, get_job_status, submit_2fa_code, request_cancel, _current_job
from services.auth import Scope, get_scope

router = APIRouter(prefix="/api/instagram", tags=["instagram"])


class BulkImportRequest(BaseModel):
    username: str
    password: str
    collection_url: Optional[str] = None
    limit: Optional[int] = None


@router.post("/bulk-import")
async def start_bulk_import(
    payload: BulkImportRequest,
    background_tasks: BackgroundTasks,
    scope: Scope = Depends(get_scope),
    db: Session = Depends(get_db),
):
    if _current_job["status"] == "running":
        raise HTTPException(status_code=409, detail="A bulk import is already running")

    background_tasks.add_task(
        run_bulk_import,
        username=payload.username,
        password=payload.password,
        db=db,
        collection_url=payload.collection_url,
        limit=payload.limit,
        user_id=scope.user_id,
        client_id=scope.client_id if not scope.user_id else None,
    )

    return {"message": "Bulk import started", "status": "running"}


@router.get("/bulk-import/status")
def bulk_import_status():
    """Poll this endpoint to track import progress."""
    return get_job_status()


class TwoFactorRequest(BaseModel):
    code: str


@router.post("/bulk-import/2fa")
async def submit_two_factor(payload: TwoFactorRequest):
    """Submit the 2FA code when Instagram requires it during bulk import."""
    try:
        await submit_2fa_code(payload.code)
        return {"message": "2FA code accepted"}
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))


@router.post("/bulk-import/cancel", status_code=200)
def cancel_import_job():
    """Signal the running import to stop after the current post finishes."""
    try:
        request_cancel()
        return {"message": "Cancellation requested — import will stop after the current item."}
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))


@router.delete("/bulk-import", status_code=204)
def reset_import_job():
    """Reset the job state back to idle (does not cancel mid-run, just clears state)."""
    _current_job.update({
        "status": "idle",
        "total": 0,
        "processed": 0,
        "imported": 0,
        "skipped": 0,
        "failed": 0,
        "current": "",
        "log": [],
        "started_at": None,
        "finished_at": None,
    })
