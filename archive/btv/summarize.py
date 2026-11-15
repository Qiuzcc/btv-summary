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

# 核心要点全章字数硬上限（提示词软约束之外的代码兜底）
KEY_POINTS_MAX_CHARS = 500

KEY_POINTS_SECTION_RE = re.compile(
    r"(^## 核心要点\s*\n)(.*?)(?=\n## |\Z)", re.MULTILINE | re.DOTALL
)

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

## 核心要点
固定 5 条，按重要性排序，每条只讲一个要点；整个章节总字数严格控制在 {key_points_max_chars} 字以内（平均每条不超过 100 字），用短句直给结论，删掉修饰语、重复举例和括号补充。

## 值得追问
- 2 到 3 个视频没有回答、但值得继续查的问题。
"""

COMPRESS_KEY_POINTS_USER = """下面是视频笔记的「核心要点」章节，当前约 {current} 字，超过 {limit} 字的上限。
请压缩改写，使全章总字数不超过 {limit} 字，要求：
- 保持 5 条编号列表，按重要性排序，每条只保留一个核心结论；
- 保留关键数字、专有名词和结论，删去修饰语、重复举例和括号补充；
- 只输出压缩后的 5 条列表，不要标题、开场白或其他章节，不要编造信息。

原文：
{body}
"""


def format_ts(seconds: float) -> str:
    total = max(0, int(seconds))
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours:
        return f"{hours:02d}:{minutes:02d}:{secs:02d}"
    return f"{minutes:02d}:{secs:02d}"


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
                    key_points_max_chars=KEY_POINTS_MAX_CHARS,
                ),
            },
        ],
        temperature=0.2,
        timeout=300,
        on_usage=on_usage,
    )

    markdown = _strip_code_fence(markdown)
    markdown = _enforce_key_points_limit(markdown, config, progress, on_usage)
    if not markdown.lstrip().startswith("#"):
        markdown = f"# {transcript.title}\n\n{markdown}"
    return markdown


def _strip_code_fence(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^\s*```(?:markdown|md)?\s*\n", "", text)
        text = re.sub(r"\n```\s*$", "", text)
    return text.strip()


def _count_key_points_chars(body: str) -> int:
    """统计核心要点正文字数：去掉 Markdown 符号、列表编号和空白后按字符计。"""
    text = re.sub(r"[*`]", "", body)
    text = re.sub(r"^\s*\d+\.\s*", "", text, flags=re.MULTILINE)
    return len(re.sub(r"\s", "", text))


def _enforce_key_points_limit(
    markdown: str,
    config: dict,
    progress: Callable[[str], None],
    on_usage: Callable[[dict], None] | None,
) -> str:
    """核心要点超字数上限时，触发一次定向 LLM 压缩；失败则保留原文降级。"""
    match = KEY_POINTS_SECTION_RE.search(markdown)
    if not match:
        return markdown

    body = match.group(2).strip()
    current = _count_key_points_chars(body)
    if current <= KEY_POINTS_MAX_CHARS:
        return markdown

    progress(
        f"核心要点 {current} 字超出 {KEY_POINTS_MAX_CHARS} 字上限，定向压缩中..."
    )
    try:
        compressed = chat(
            config,
            [
                {"role": "system", "content": MAP_SYSTEM},
                {
                    "role": "user",
                    "content": COMPRESS_KEY_POINTS_USER.format(
                        current=current,
                        limit=KEY_POINTS_MAX_CHARS,
                        body=body,
                    ),
                },
            ],
            temperature=0.2,
            on_usage=on_usage,
        )
    except RuntimeError as exc:
        progress(f"核心要点压缩失败，保留原文：{exc}")
        return markdown

    compressed = _strip_code_fence(compressed).strip()
    # 只在确实缩短时替换，避免无效结果覆盖原文
    if _count_key_points_chars(compressed) < current:
        return (
            markdown[: match.start(2)]
            + compressed
            + "\n"
            + markdown[match.end(2) :]
        )
    progress("压缩后仍未明显缩短，保留原文")
    return markdown
