"""
Downloads Instagram reels via yt-dlp, extracts audio, transcribes with local Whisper.
"""
import os
import tempfile
import asyncio
from pathlib import Path
from typing import Optional

import yt_dlp
from faster_whisper import WhisperModel

from config import settings

# Loaded once at startup — model downloaded automatically on first run
# small ~460MB | medium ~1.5GB | large ~3GB
_whisper_model = None

def _get_model():
    global _whisper_model
    if _whisper_model is None:
        _whisper_model = WhisperModel(
            settings.whisper_model,
            device="cpu",
            compute_type="int8",  # efficient on CPU, no GPU needed
        )
    return _whisper_model


async def download_reel(url: str, output_dir: str) -> dict:
    """
    Download a reel from the given URL using yt-dlp.
    Returns dict with video_path, audio_path, thumbnail_path, title, duration.
    """
    output_template = os.path.join(output_dir, "%(id)s.%(ext)s")
    audio_template = os.path.join(output_dir, "%(id)s_audio.%(ext)s")

    ydl_opts = {
        "outtmpl": output_template,
        "format": "best[ext=mp4]/best",
        "quiet": True,
        "no_warnings": True,
        "writeinfojson": False,
        "writethumbnail": True,
    }

    info = {}
    loop = asyncio.get_event_loop()

    def _download():
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            return ydl.extract_info(url, download=True)

    result = await loop.run_in_executor(None, _download)

    video_id = result.get("id", "video")
    title = result.get("title", "Instagram Reel")

    # Find downloaded files
    video_path = None
    thumbnail_path = None
    for f in Path(output_dir).iterdir():
        if f.stem == video_id and f.suffix in (".mp4", ".webm", ".mkv"):
            video_path = str(f)
        if f.stem == video_id and f.suffix in (".jpg", ".jpeg", ".png", ".webp"):
            thumbnail_path = str(f)

    # Extract audio for transcription
    audio_path = os.path.join(output_dir, f"{video_id}_audio.mp3")
    audio_opts = {
        "outtmpl": audio_path.replace(".mp3", ".%(ext)s"),
        "format": "bestaudio/best",
        "postprocessors": [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": "128",
            }
        ],
        "quiet": True,
    }

    def _extract_audio():
        with yt_dlp.YoutubeDL(audio_opts) as ydl:
            ydl.download([url])

    await loop.run_in_executor(None, _extract_audio)

    return {
        "video_id": video_id,
        "title": title,
        "video_path": video_path,
        "audio_path": audio_path if os.path.exists(audio_path) else None,
        "thumbnail_path": thumbnail_path,
        "duration": result.get("duration"),
        "description": result.get("description", ""),
    }


async def transcribe_audio(audio_path: str) -> Optional[str]:
    """Transcribe audio file using local Whisper model (runs on-device, no API key needed)."""
    if not audio_path or not os.path.exists(audio_path):
        return None

    loop = asyncio.get_event_loop()

    def _transcribe():
        model = _get_model()
        segments, _ = model.transcribe(audio_path, language="en")
        return " ".join(seg.text.strip() for seg in segments)

    return await loop.run_in_executor(None, _transcribe)


async def process_reel_url(url: str) -> dict:
    """
    Full pipeline: download reel → extract audio → transcribe.
    Returns all metadata needed for recipe extraction.
    """
    with tempfile.TemporaryDirectory(dir=settings.upload_dir) as tmp_dir:
        os.makedirs(tmp_dir, exist_ok=True)
        video_data = await download_reel(url, tmp_dir)
        transcript = await transcribe_audio(video_data.get("audio_path"))

        # Copy thumbnail to permanent uploads if it exists
        thumbnail_dest = None
        if video_data.get("thumbnail_path"):
            perm_dir = os.path.join(settings.upload_dir, "thumbnails")
            os.makedirs(perm_dir, exist_ok=True)
            dest = os.path.join(perm_dir, Path(video_data["thumbnail_path"]).name)
            import shutil
            shutil.copy2(video_data["thumbnail_path"], dest)
            thumbnail_dest = dest

        return {
            "title": video_data["title"],
            "source_url": url,
            "transcript": transcript,
            "description": video_data.get("description", ""),
            "thumbnail_path": thumbnail_dest,
            "duration": video_data.get("duration"),
        }
