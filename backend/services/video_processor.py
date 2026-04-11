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

    _cookies = os.path.expanduser(
        "~/Documents/Claude/ReelRecipe/Cookies/www.instagram.com_cookies.txt"
    )

    ydl_opts = {
        "outtmpl": output_template,
        "format": "best[ext=mp4]/best",
        "quiet": True,
        "no_warnings": True,
        "writeinfojson": False,
        "writethumbnail": True,
        "http_headers": {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Referer": "https://www.instagram.com/",
        },
        **({"cookiefile": _cookies} if os.path.exists(_cookies) else {}),
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


def _extract_mid_frame(video_path: str, duration: float, output_path: str) -> bool:
    """
    Extract a single frame at 45% of video duration using ffmpeg.
    Falls back to 5s if duration unknown. Returns True on success.
    """
    import subprocess
    seek = max(1, (duration or 12) * 0.45)
    result = subprocess.run(
        [
            "ffmpeg", "-ss", str(seek), "-i", video_path,
            "-vframes", "1", "-q:v", "2", output_path,
            "-y", "-loglevel", "quiet",
        ],
        capture_output=True,
    )
    return result.returncode == 0 and os.path.exists(output_path)


async def process_reel_url(url: str) -> dict:
    """
    Full pipeline: download reel → extract audio → transcribe.
    Uses a mid-video frame (45% in) as the thumbnail so it usually shows
    the finished dish rather than an intro/title card.
    """
    import shutil
    with tempfile.TemporaryDirectory(dir=settings.upload_dir) as tmp_dir:
        os.makedirs(tmp_dir, exist_ok=True)
        video_data = await download_reel(url, tmp_dir)
        transcript = await transcribe_audio(video_data.get("audio_path"))

        perm_dir = os.path.join(settings.upload_dir, "thumbnails")
        os.makedirs(perm_dir, exist_ok=True)

        thumbnail_dest = None
        video_path = video_data.get("video_path")
        duration = video_data.get("duration")

        # Prefer a mid-video frame; fall back to yt-dlp's thumbnail
        if video_path and os.path.exists(video_path):
            mid_frame = os.path.join(tmp_dir, f"{video_data['video_id']}_mid.jpg")
            loop = asyncio.get_event_loop()
            success = await loop.run_in_executor(
                None, _extract_mid_frame, video_path, duration or 0, mid_frame
            )
            if success:
                dest = os.path.join(perm_dir, Path(mid_frame).name)
                shutil.copy2(mid_frame, dest)
                thumbnail_dest = dest

        if not thumbnail_dest and video_data.get("thumbnail_path"):
            dest = os.path.join(perm_dir, Path(video_data["thumbnail_path"]).name)
            shutil.copy2(video_data["thumbnail_path"], dest)
            thumbnail_dest = dest

        return {
            "title": video_data["title"],
            "source_url": url,
            "transcript": transcript,
            "description": video_data.get("description", ""),
            "thumbnail_path": thumbnail_dest,
            "duration": duration,
        }
