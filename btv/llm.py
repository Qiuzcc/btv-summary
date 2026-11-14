from __future__ import annotations

import sys
import time
from typing import Callable

import requests

# 可重试的 HTTP 状态码：限流与服务端临时故障
_RETRYABLE_STATUS = {408, 409, 429, 500, 502, 503, 504}


def _retry_after(response: requests.Response) -> float | None:
    """读取 Retry-After 头（秒），没有则返回 None。"""
    value = response.headers.get("Retry-After")
    if not value:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        return None


def chat(
    config: dict,
    messages: list[dict],
    temperature: float | None = None,
    timeout: int = 240,
    on_usage: Callable[[dict], None] | None = None,
) -> str:
    llm = config["llm"]
    api_key = llm.get("api_key") or ""
    base_url = (llm.get("base_url") or "").rstrip("/")
    if not api_key:
        raise RuntimeError("未配置 LLM，请执行：btv config set llm.api_key sk-xxx")
    if not base_url:
        raise RuntimeError("未配置 llm.base_url")

    max_retries = int(llm.get("max_retries", 3))
    payload = {
        "model": llm.get("model") or "deepseek-chat",
        "messages": messages,
        "temperature": llm.get("temperature", 0.3)
        if temperature is None
        else temperature,
        "stream": False,
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    url = base_url + "/chat/completions"

    last_error = ""
    for attempt in range(max_retries + 1):
        try:
            response = requests.post(url, headers=headers, json=payload, timeout=timeout)
        except requests.RequestException as exc:
            # 网络层错误（超时、连接中断、DNS 等），退避后重试
            last_error = f"网络错误：{exc}"
            if attempt >= max_retries:
                break
            delay = 2 ** attempt
            print(
                f"[btv] LLM 请求失败（{last_error}），"
                f"{delay}s 后重试（{attempt + 1}/{max_retries}）",
                file=sys.stderr,
            )
            time.sleep(delay)
            continue

        if response.status_code < 400:
            data = response.json()
            try:
                content = data["choices"][0]["message"]["content"].strip()
            except (KeyError, IndexError, TypeError) as exc:
                raise RuntimeError(
                    f"LLM 返回格式异常：{str(data)[:300]}"
                ) from exc
            if on_usage and isinstance(data.get("usage"), dict):
                on_usage(
                    {
                        "model": payload["model"],
                        "prompt_tokens": data["usage"].get("prompt_tokens", 0),
                        "completion_tokens": data["usage"].get("completion_tokens", 0),
                    }
                )
            return content

        last_error = f"HTTP {response.status_code}：{response.text[:400]}"
        # 配置类错误（鉴权失败、模型不存在等）重试无意义，立即抛出
        if response.status_code not in _RETRYABLE_STATUS:
            raise RuntimeError(f"LLM 请求失败 {last_error}")
        if attempt >= max_retries:
            break

        wait = _retry_after(response)
        if wait is None:
            wait = 2 ** attempt
        print(
            f"[btv] LLM 服务临时故障（{last_error[:120]}），"
            f"{wait:.0f}s 后重试（{attempt + 1}/{max_retries}）",
            file=sys.stderr,
        )
        time.sleep(wait)

    raise RuntimeError(f"LLM 请求重试 {max_retries} 次后仍失败：{last_error}")
