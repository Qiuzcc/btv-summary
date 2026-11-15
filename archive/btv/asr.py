from __future__ import annotations

from pathlib import Path
from typing import Callable

import requests

from .models import Segment


def transcribe(
    path: Path,
    config: dict,
    on_usage: Callable[[str, float], None] | None = None,
) -> list[Segment]:
    language = config["asr"].get("language") or ""
    cloud = config["cloud_asr"]
    model = cloud.get("model") or "whisper-1"
    segments = transcribe_cloud(
        path,
        base_url=cloud.get("base_url") or "",
        api_key=cloud.get("api_key") or "",
        model=model,
        language=language,
    )
    if on_usage and segments:
        # 按最后一段结束时间计音频秒数
        on_usage(model, float(segments[-1].end))
    return segments


def transcribe_cloud(
    path: Path,
    base_url: str,
    api_key: str,
    model: str,
    language: str = "",
) -> list[Segment]:
    if not base_url or not api_key:
        raise RuntimeError(
            "云端转写需要配置 cloud_asr.base_url 与 cloud_asr.api_key"
        )
    url = base_url.rstrip("/") + "/audio/transcriptions"
    data = {"model": model, "response_format": "verbose_json"}
    if language:
        data["language"] = language
    mime = "audio/mpeg" if path.suffix.lower() == ".mp3" else "audio/wav"

    try:
        with open(path, "rb") as handle:
            response = requests.post(
                url,
                headers={"Authorization": f"Bearer {api_key}"},
                files={"file": (path.name, handle, mime)},
                data=data,
                timeout=900,
            )
    except requests.RequestException as exc:
        raise RuntimeError(f"云端转写请求失败：{exc}") from exc
    if response.status_code >= 400:
        raise RuntimeError(
            f"云端转写失败 {response.status_code}：{response.text[:300]}"
        )

    payload = response.json()
    result = []
    for item in payload.get("segments") or []:
        text = str(item.get("text") or "").strip()
        if text:
            result.append(
                Segment(float(item["start"]), float(item["end"]), text)
            )
    if not result and payload.get("text"):
        result.append(Segment(0.0, 0.0, str(payload["text"]).strip()))
    if not result:
        raise RuntimeError("云端转写没有返回文本")
    return result
