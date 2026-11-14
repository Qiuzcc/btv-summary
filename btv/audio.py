from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import yt_dlp


def download_audio(
    url: str, dest_dir: Path, sessdata: str = "", cookie_path: str | None = None
) -> Path:
    dest_dir.mkdir(parents=True, exist_ok=True)
    mp3_path = dest_dir / "audio.mp3"
    if mp3_path.exists():
        return mp3_path

    if shutil.which("ffmpeg") is None:
        raise RuntimeError("未找到 ffmpeg，请先安装：brew install ffmpeg")

    # 兼容旧版本缓存的 wav：直接转码，避免重新下载
    legacy_wav = dest_dir / "audio.wav"
    if legacy_wav.exists():
        _transcode_to_mp3(legacy_wav, mp3_path)
        return mp3_path

    cookie_file = _write_cookie_file(dest_dir, sessdata, cookie_path)
    options = {
        "format": "bestaudio/best",
        "outtmpl": str(dest_dir / "audio.%(ext)s"),
        "quiet": True,
        "noprogress": True,
        "no_warnings": True,
        "noplaylist": True,
    }
    if cookie_file:
        options["cookiefile"] = str(cookie_file)

    try:
        with yt_dlp.YoutubeDL(options) as ydl:
            ydl.download([url])
    except yt_dlp.utils.DownloadError as exc:
        raise RuntimeError(f"音频下载失败：{exc}") from exc

    sources = [
        path
        for path in dest_dir.iterdir()
        if path.name.startswith("audio.")
        and path.suffix not in {".part", ".wav", ".mp3"}
    ]
    if not sources:
        raise RuntimeError("yt-dlp 没有产出音频文件")
    source = max(sources, key=lambda path: path.stat().st_size)

    _transcode_to_mp3(source, mp3_path)
    return mp3_path


def _transcode_to_mp3(source: Path, mp3_path: Path) -> None:
    # 语音转写用 64kbps 单声道：体积约为 wav 的 1/4，识别质量无差异
    result = subprocess.run(
        [
            "ffmpeg", "-y", "-i", str(source),
            "-ar", "16000", "-ac", "1", "-vn", "-b:a", "64k", str(mp3_path),
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"音频转码失败：{result.stderr[-500:]}")


def _write_cookie_file(
    dest_dir: Path, sessdata: str, cookie_path: str | None
) -> Path | None:
    if cookie_path:
        return Path(cookie_path)
    if not sessdata:
        return None
    path = dest_dir / "cookies.txt"
    path.write_text(
        "# Netscape HTTP Cookie File\n"
        ".bilibili.com\tTRUE\t/\tFALSE\t0\tSESSDATA\t" + sessdata + "\n",
        encoding="utf-8",
    )
    os.chmod(path, 0o600)
    return path
