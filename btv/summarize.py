from __future__ import annotations

import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Callable

from .llm import chat
from .models import Segment, Transcript

DETAILS = {
    "brief": {"chunk_seconds": 720, "min_bullets": 2, "max_bullets": 4},
    "normal": {"chunk_seconds": 480, "min_bullets": 3, "max_bullets": 6},
    "deep": {"chunk_seconds": 300, "min_bullets": 4, "max_bullets": 8},
}

MAP_SYSTEM = (
    "你是严谨的视频内容提炼助手，只依据给定的转写文本工作，"
    "不补充转写中没有出现的信息。"
)

MAP_USER = """以下是视频《{title}》第 {index}/{total} 段的转写，时间范围 {start} 到 {end}。
请提炼这一段的要点，用 {min_bullets} 到 {max_bullets} 条 Markdown 列表输出。
每条以 [mm:ss] 开头，对应该要点出现的时间；只写要点，不要开场白，不要概括本段之外的内容。

转写：
{body}
"""

REDUCE_SYSTEM = (
    "你是资深内容编辑，负责把分段笔记整合成一篇可读的视频摘要。"
    "只使用笔记中的信息，不要编造，不要输出与笔记无关的评价。"
)

REDUCE_USER = """视频信息：
- 标题：{title}
- UP 主：{owner}
- 时长：{duration}
- 链接：{url}

下面是按时间顺序整理的分段要点：
{notes}

请输出一篇中文 Markdown 笔记，严格使用以下结构，不要用代码块包裹：

# {title}

> 来源：{url} · 时长 {duration} · UP 主 {owner}

## TL;DR
用 2 到 3 句话概括视频的核心结论。

## 章节
按内容划分 3 到 8 个章节，每章格式为：
### [起始时间]({url}?t=起始秒数) 章节标题
- 2 到 4 条要点

## 核心要点
5 到 10 条，按重要性排序。

## 术语与金句
- 列出关键概念、定义或值得记录的原话；没有就写“无”。

## 值得追问
- 2 到 3 个视频没有回答、但值得继续查的问题。
"""


def format_ts(seconds: float) -> str:
    total = max(0, int(seconds))
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours:
        return f"{hours:02d}:{minutes:02d}:{secs:02d}"
    return f"{minutes:02d}:{secs:02d}"


def parse_ts(text: str) -> int:
    parts = [int(p) for p in text.split(":")]
    if len(parts) == 3:
        return parts[0] * 3600 + parts[1] * 60 + parts[2]
    if len(parts) == 2:
        return parts[0] * 60 + parts[1]
    return parts[0] if parts else 0


def linkify_chapter_timestamps(markdown: str, url: str) -> str:
    pattern = re.compile(r"^(###\s*)\[(\d{1,2}(?::\d{2}){1,2})\](?!\()", re.MULTILINE)

    def repl(match: re.Match) -> str:
        prefix, ts = match.group(1), match.group(2)
        return f"{prefix}[{ts}]({url}?t={parse_ts(ts)})"

    return pattern.sub(repl, markdown)


def chunk_segments(
    segments: list[Segment], chunk_seconds: int, max_chars: int
) -> list[list[Segment]]:
    chunks: list[list[Segment]] = []
    current: list[Segment] = []
    start: float | None = None
    chars = 0
    last_end = 0.0

    for segment in segments:
        if start is None:
            start = segment.start
        current.append(segment)
        chars += len(segment.text)
        last_end = segment.end
        if last_end - start >= chunk_seconds or chars >= max_chars:
            chunks.append(current)
            current = []
            start = None
            chars = 0

    if current:
        chunks.append(current)
    return chunks


def _map_chunk(
    config: dict,
    settings: dict,
    title: str,
    total: int,
    index: int,
    chunk: list[Segment],
    on_usage: Callable[[dict], None] | None = None,
) -> str:
    body = "\n".join(
        f"[{format_ts(segment.start)}] {segment.text}" for segment in chunk
    )
    return chat(
        config,
        [
            {"role": "system", "content": MAP_SYSTEM},
            {
                "role": "user",
                "content": MAP_USER.format(
                    title=title,
                    index=index,
                    total=total,
                    start=format_ts(chunk[0].start),
                    end=format_ts(chunk[-1].end),
                    min_bullets=settings["min_bullets"],
                    max_bullets=settings["max_bullets"],
                    body=body,
                ),
            },
        ],
        on_usage=on_usage,
    )


def summarize(
    transcript: Transcript,
    config: dict,
    detail: str = "normal",
    chunk_seconds: int | None = None,
    progress: Callable[[str], None] | None = None,
    on_usage: Callable[[dict], None] | None = None,
) -> str:
    progress = progress or (lambda _message: None)
    if not transcript.segments:
        raise RuntimeError("转写内容为空，无法总结")

    settings = DETAILS.get(detail, DETAILS["normal"])
    target_seconds = chunk_seconds or settings["chunk_seconds"]
    max_chars = int(config["llm"].get("max_chars") or 6000)
    chunks = chunk_segments(transcript.segments, target_seconds, max_chars)
    url = f"https://www.bilibili.com/video/{transcript.bvid}"
    total = len(chunks)

    progress(f"并发总结 {total} 段...")
    notes = [""] * total
    with ThreadPoolExecutor(max_workers=total) as executor:
        futures = {
            executor.submit(
                _map_chunk,
                config,
                settings,
                transcript.title,
                total,
                index,
                chunk,
                on_usage,
            ): index
            for index, chunk in enumerate(chunks, start=1)
        }
        for future in as_completed(futures):
            index = futures[future]
            try:
                note = future.result()
            except RuntimeError as exc:
                # 单块重试耗尽也不拖垮整次总结：用原始转写文本降级
                progress(f"第 {index}/{total} 段总结失败，用原文降级：{exc}")
                chunk = chunks[index - 1]
                note = "\n".join(
                    f"- [{format_ts(segment.start)}] {segment.text}"
                    for segment in chunk
                )
            notes[index - 1] = note
            progress(f"第 {index}/{total} 段完成")

    notes_text = "\n\n".join(
        f"#### 第 {index} 段\n{note}" for index, note in enumerate(notes, start=1)
    )
    progress("合并分段要点并生成最终笔记")
    markdown = chat(
        config,
        [
            {"role": "system", "content": REDUCE_SYSTEM},
            {
                "role": "user",
                "content": REDUCE_USER.format(
                    title=transcript.title,
                    owner=transcript.owner or "未知",
                    duration=format_ts(transcript.duration),
                    url=url,
                    notes=notes_text,
                ),
            },
        ],
        temperature=0.2,
        timeout=300,
        on_usage=on_usage,
    )

    markdown = _strip_code_fence(markdown)
    markdown = linkify_chapter_timestamps(markdown, url)
    if not markdown.lstrip().startswith("#"):
        markdown = f"# {transcript.title}\n\n{markdown}"
    return markdown


def _strip_code_fence(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^\s*```(?:markdown|md)?\s*\n", "", text)
        text = re.sub(r"\n```\s*$", "", text)
    return text.strip()
