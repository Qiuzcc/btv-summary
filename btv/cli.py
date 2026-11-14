from __future__ import annotations

import argparse
import getpass
import json
import re
import sys
from pathlib import Path

import requests

from . import __version__
from . import config as cfgmod
from . import usage as usagemod
from .asr import transcribe
from .audio import download_audio
from .bilibili import BilibiliClient, resolve_bvid
from .models import Transcript
from .summarize import summarize


def log(message: str) -> None:
    print(f"[btv] {message}", file=sys.stderr, flush=True)


def _add_source_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--refresh", action="store_true", help="忽略缓存，重新获取字幕或转写"
    )
    parser.add_argument(
        "--no-subtitle", action="store_true", help="跳过 B 站字幕，直接转写音频"
    )


def _load_transcript(
    bvid: str,
    config: dict,
    args: argparse.Namespace,
    asr_sink=None,
) -> Transcript:
    cache_dir = cfgmod.ensure_cache_dir() / bvid
    cache_dir.mkdir(parents=True, exist_ok=True)
    transcript_file = cache_dir / "transcript.json"

    if transcript_file.exists() and not args.refresh:
        try:
            return Transcript.from_dict(
                json.loads(transcript_file.read_text(encoding="utf-8"))
            )
        except (json.JSONDecodeError, KeyError):
            log("本地转写缓存损坏，重新获取")

    sessdata = cfgmod.get(config, "bilibili.sessdata", "")
    client = BilibiliClient(sessdata)

    meta = None
    try:
        meta = client.get_meta(bvid)
    except (RuntimeError, requests.RequestException) as exc:
        log(f"读取视频信息失败：{exc}")

    if not args.no_subtitle:
        if not sessdata:
            log("未登录 B 站，跳过字幕，改用音频转写")
        else:
            try:
                transcript = client.get_transcript(bvid)
                _save_transcript(transcript, transcript_file)
                return transcript
            except (RuntimeError, requests.RequestException) as exc:
                log(f"字幕获取失败：{exc}，改用音频转写")

    url = f"https://www.bilibili.com/video/{bvid}/"
    log("下载音频中...")
    audio_path = download_audio(url, cache_dir, sessdata)
    log("开始转写（云端），耗时取决于视频长度...")
    segments = transcribe(audio_path, config, on_usage=asr_sink)

    duration = int(meta["duration"]) if meta else int(segments[-1].end)
    transcript = Transcript(
        bvid=bvid,
        title=(meta or {}).get("title") or bvid,
        owner=(meta or {}).get("owner") or "",
        duration=duration,
        source="asr",
        segments=segments,
    )
    _save_transcript(transcript, transcript_file)
    return transcript


def _save_transcript(transcript: Transcript, path: Path) -> None:
    path.write_text(
        json.dumps(transcript.to_dict(), ensure_ascii=False), encoding="utf-8"
    )


def _safe_dirname(name: str, fallback: str) -> str:
    """把视频标题转成合法目录名，标题为空时回退到 BV 号。"""
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", name)
    name = re.sub(r"\s+", " ", name).strip().strip(".")
    return (name or fallback)[:80]


def _output_dir(transcript: Transcript) -> Path:
    directory = Path("out") / _safe_dirname(transcript.title, transcript.bvid)
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def _output_path(
    args: argparse.Namespace, transcript: Transcript, extension: str
) -> Path:
    if args.output:
        candidate = Path(args.output)
        if candidate.suffix.lower() in {".md", ".json"}:
            candidate.parent.mkdir(parents=True, exist_ok=True)
            return candidate
        candidate.mkdir(parents=True, exist_ok=True)
        return candidate / f"summary.{extension}"
    return _output_dir(transcript) / f"summary.{extension}"


def cmd_login(args: argparse.Namespace) -> None:
    raw = args.cookie or getpass.getpass("粘贴 SESSDATA（浏览器 Cookie 中的值）: ")
    sessdata = _extract_sessdata(raw)
    if not sessdata:
        raise RuntimeError("SESSDATA 为空")

    config = cfgmod.load_config()
    config["bilibili"]["sessdata"] = sessdata
    cfgmod.save_config(config)
    print(f"已保存登录态到 {cfgmod.CONFIG_FILE}")


def _extract_sessdata(raw: str) -> str:
    raw = raw.strip()
    if "SESSDATA=" in raw:
        return raw.split("SESSDATA=", 1)[1].split(";", 1)[0].strip()
    return raw


def cmd_config(args: argparse.Namespace) -> None:
    config = cfgmod.load_config()
    if args.action == "show":
        print(json.dumps(cfgmod.masked(config), ensure_ascii=False, indent=2))
        return
    if not args.key or args.value is None:
        raise RuntimeError("用法：btv config set <key> <value>")
    cfgmod.set_value(config, args.key, args.value)
    cfgmod.save_config(config)
    print(f"已设置 {args.key}，写入 {cfgmod.CONFIG_FILE}")


def _print_run_cost(record: dict) -> None:
    parts = []
    for item in record["llm"]["items"]:
        parts.append(
            f"LLM {item['model']} {item['prompt_tokens']}+{item['completion_tokens']} tok ¥{item['cost']:.4f}"
        )
    for item in record["llm"]["unknown"]:
        parts.append(
            f"LLM {item['model']} {item['prompt_tokens']}+{item['completion_tokens']} tok（未配置单价）"
        )
    for item in record["asr"]["items"]:
        parts.append(f"ASR {item['model']} {item['seconds']:.0f}s ¥{item['cost']:.4f}")
    for item in record["asr"]["unknown"]:
        parts.append(f"ASR {item['model']} {item['seconds']:.0f}s（未配置单价）")
    detail = "；".join(parts) if parts else "无外部调用"
    log(f"本轮成本 ¥{record['total']:.4f}（{detail}）")


def cmd_subtitle(args: argparse.Namespace) -> None:
    config = cfgmod.load_config()
    bvid = resolve_bvid(args.url)
    collector = usagemod.UsageCollector(config, bvid, bvid)
    transcript = _load_transcript(
        bvid, config, args, asr_sink=collector.record_asr
    )
    collector.title = transcript.title
    log(f"《{transcript.title}》 · {len(transcript.segments)} 段 · {transcript.source}")

    srt_path = Path(args.srt) if args.srt else None
    json_path = Path(args.json) if args.json else None
    if not srt_path and not json_path:
        directory = _output_dir(transcript)
        srt_path = directory / "transcript.srt"
        json_path = directory / "transcript.json"

    written = []
    if srt_path:
        srt_path.parent.mkdir(parents=True, exist_ok=True)
        srt_path.write_text(transcript.to_srt(), encoding="utf-8")
        written.append(srt_path)
    if json_path:
        json_path.parent.mkdir(parents=True, exist_ok=True)
        _save_transcript(transcript, json_path)
        written.append(json_path)

    for path in written:
        print(path)

    if collector.llm_calls or collector.asr_by_model:
        record = collector.save()
        _print_run_cost(record)


def cmd_usage(args: argparse.Namespace) -> None:
    if args.reset:
        path = usagemod.reset()
        print(f"已清空成本记录：{path}")
        return
    print(usagemod.format_totals(cfgmod.load_config()))


def cmd_summarize(args: argparse.Namespace) -> None:
    config = cfgmod.load_config()
    if args.model:
        config["llm"]["model"] = args.model

    bvid = resolve_bvid(args.url)
    collector = usagemod.UsageCollector(config, bvid, bvid)
    transcript = _load_transcript(
        bvid, config, args, asr_sink=collector.record_asr
    )
    collector.title = transcript.title
    log(f"《{transcript.title}》 · {len(transcript.segments)} 段 · {transcript.source}")

    markdown = summarize(
        transcript,
        config,
        detail=args.detail,
        chunk_seconds=args.chunk_seconds,
        progress=log,
        on_usage=collector.record_llm,
    )

    extension = "md" if args.format == "md" else "json"
    path = _output_path(args, transcript, extension)
    if args.format == "md":
        path.write_text(markdown + "\n", encoding="utf-8")
    else:
        payload = {
            "bvid": transcript.bvid,
            "title": transcript.title,
            "owner": transcript.owner,
            "duration": transcript.duration,
            "source": transcript.source,
            "summary_markdown": markdown,
        }
        path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    print(path)

    record = collector.save()
    _print_run_cost(record)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="btv", description="B 站长视频要点提炼：字幕优先，Whisper 兜底"
    )
    parser.add_argument(
        "--version", action="version", version=f"%(prog)s {__version__}"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    login = subparsers.add_parser("login", help="保存 B 站 SESSDATA 登录态")
    login.add_argument("--cookie", help="直接传入 SESSDATA 或完整 Cookie 字符串")
    login.set_defaults(handler=cmd_login)

    config = subparsers.add_parser("config", help="查看或修改配置")
    config.add_argument("action", choices=["show", "set"])
    config.add_argument("key", nargs="?")
    config.add_argument("value", nargs="?")
    config.set_defaults(handler=cmd_config)

    usage_parser = subparsers.add_parser("usage", help="查看累计成本统计")
    usage_parser.add_argument("--reset", action="store_true", help="清空成本明细")
    usage_parser.set_defaults(handler=cmd_usage)

    subtitle = subparsers.add_parser("subtitle", help="只获取字幕/转写")
    subtitle.add_argument("url", help="B 站链接或 BV 号")
    subtitle.add_argument("--srt", help="SRT 输出路径")
    subtitle.add_argument("--json", help="JSON 输出路径")
    _add_source_args(subtitle)
    subtitle.set_defaults(handler=cmd_subtitle)

    summarize_parser = subparsers.add_parser(
        "summarize", aliases=["s"], help="生成视频要点笔记"
    )
    summarize_parser.add_argument("url", help="B 站链接或 BV 号")
    summarize_parser.add_argument("-o", "--output", help="输出文件或目录")
    summarize_parser.add_argument(
        "--format", choices=["md", "json"], default="md", help="输出格式"
    )
    summarize_parser.add_argument(
        "--detail", choices=["brief", "normal", "deep"], default="normal"
    )
    summarize_parser.add_argument("--chunk-seconds", type=int, help="分块时长（秒）")
    summarize_parser.add_argument("--model", help="临时覆盖 LLM 模型")
    _add_source_args(summarize_parser)
    summarize_parser.set_defaults(handler=cmd_summarize)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    try:
        args.handler(args)
    except KeyboardInterrupt:
        print("已取消", file=sys.stderr)
        sys.exit(130)
    except RuntimeError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        sys.exit(1)
