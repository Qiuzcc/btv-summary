from __future__ import annotations

import copy
import json
import os
from pathlib import Path
from typing import Any

CONFIG_DIR = Path(os.environ.get("BTV_CONFIG_DIR", Path.home() / ".config" / "btv"))
CONFIG_FILE = CONFIG_DIR / "config.json"
CACHE_DIR = Path(os.environ.get("BTV_CACHE_DIR", Path.home() / ".cache" / "btv"))

DEFAULTS: dict[str, Any] = {
    "bilibili": {"sessdata": ""},
    "llm": {
        "base_url": "https://api.deepseek.com/v1",
        "api_key": "",
        "model": "deepseek-chat",
        "temperature": 0.3,
        "max_chars": 6000,
        "max_retries": 3,
    },
    "asr": {
        "language": "",
    },
    "cloud_asr": {
        "base_url": "",
        "api_key": "",
        "model": "XingChenAGI/XingChenASR-Diarize-V3.0",
    },
}


def _deep_merge(base: dict, override: dict) -> dict:
    merged = copy.deepcopy(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def load_config() -> dict:
    if not CONFIG_FILE.exists():
        return copy.deepcopy(DEFAULTS)
    try:
        user_config = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"配置文件不是合法 JSON：{CONFIG_FILE}") from exc
    return _deep_merge(DEFAULTS, user_config)


def save_config(config: dict) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    data = json.dumps(config, ensure_ascii=False, indent=2) + "\n"
    fd = os.open(CONFIG_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(data)


def get(config: dict, path: str, default: Any = None) -> Any:
    current: Any = config
    for part in path.split("."):
        if not isinstance(current, dict) or part not in current:
            return default
        current = current[part]
    return current


def _coerce(value: str) -> Any:
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return value


def set_value(config: dict, path: str, value: str) -> None:
    parts = path.split(".")
    current = config
    for part in parts[:-1]:
        node = current.get(part)
        if not isinstance(node, dict):
            node = {}
            current[part] = node
        current = node
    current[parts[-1]] = _coerce(value)


def masked(config: dict) -> dict:
    safe = copy.deepcopy(config)
    for path in ("bilibili.sessdata", "llm.api_key", "cloud_asr.api_key"):
        value = get(safe, path)
        if value:
            set_value(safe, path, value[:4] + "****" + value[-4:] if len(value) > 8 else "****")
    return safe


def ensure_cache_dir() -> Path:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    return CACHE_DIR
