"""
Upload files to Cloudflare R2 (S3-compatible object storage).
Returns the public CDN URL on success, None if R2 is not configured or the upload fails.
Falls back gracefully so callers can use the local path as a fallback.
"""
import asyncio
import io
import os
from typing import Optional

from config import settings


def is_configured() -> bool:
    return all([
        settings.r2_account_id,
        settings.r2_access_key_id,
        settings.r2_secret_access_key,
        settings.r2_bucket_name,
        settings.r2_public_url,
    ])


def _make_client():
    import boto3
    from botocore.config import Config
    return boto3.client(
        "s3",
        endpoint_url=f"https://{settings.r2_account_id}.r2.cloudflarestorage.com",
        aws_access_key_id=settings.r2_access_key_id,
        aws_secret_access_key=settings.r2_secret_access_key,
        config=Config(signature_version="s3v4"),
        region_name="auto",
    )


def _public_url(key: str) -> str:
    return f"{settings.r2_public_url.rstrip('/')}/{key}"


def _upload_bytes_sync(data: bytes, key: str, content_type: str) -> Optional[str]:
    if not is_configured():
        return None
    try:
        client = _make_client()
        client.upload_fileobj(
            io.BytesIO(data), settings.r2_bucket_name, key,
            ExtraArgs={"ContentType": content_type},
        )
        return _public_url(key)
    except Exception:
        return None


def _upload_file_sync(local_path: str, key: str, content_type: str) -> Optional[str]:
    if not is_configured():
        return None
    try:
        client = _make_client()
        with open(local_path, "rb") as fh:
            client.upload_fileobj(
                fh, settings.r2_bucket_name, key,
                ExtraArgs={"ContentType": content_type},
            )
        return _public_url(key)
    except Exception:
        return None


async def upload_bytes(data: bytes, filename: str, content_type: str = "image/jpeg") -> Optional[str]:
    """Upload raw bytes to R2 under thumbnails/<filename>. Returns public URL or None."""
    key = f"thumbnails/{filename}"
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _upload_bytes_sync, data, key, content_type)


async def upload_local_file(local_path: str, content_type: str = "image/jpeg") -> Optional[str]:
    """Upload a local file to R2 under thumbnails/<basename>. Returns public URL or None."""
    key = f"thumbnails/{os.path.basename(local_path)}"
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _upload_file_sync, local_path, key, content_type)
