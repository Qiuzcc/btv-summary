"""成本统计：单价表、逐轮明细持久化与聚合。

口径：
- LLM 成本 = 每次成功响应的真实 token 用量 × 模型单价（每百万 token，元）。
- ASR 成本 = 音频实际秒数 × 模型每秒单价（元/秒），免费模型单价为 0。
- 明细以 JSONL 追加写入 ~/.cache/btv/usage.jsonl，聚合只对明细做累加，
  不用单价×笔数等派生方式反推。
"""

from __future__ import annotations

import json
import threading
from datetime import datetime
from pathlib import Path
from typing import Callable

from . import config as cfgmod

# 硅基流动参考单价（2026-11，元 / 百万 token），可用 config 的 pricing 覆盖
LLM_PRICES: dict[str, tuple[float, float]] = {
    # model_id: (输入单价, 输出单价)
    "zai-org/GLM-5.3": (0.80, 2.80),
    "zai-org/GLM-5.3-Flash": (0.80, 2.80),
    "zai-org/GLM-4.5-Air": (1.00, 6.00),
    "deepseek-ai/DeepSeek-V4.1-Flash": (2.00, 8.00),
    "deepseek-ai/DeepSeek-V3.2": (4.00, 6.00),
    "deepseek-ai/DeepSeek-V4-Pro": (12.00, 24.00),
    "deepseek-ai/DeepSeek-R1": (8.00, 16.00),
    "Qwen/Qwen2.5-72B-Instruct": (0.70, 1.40),
    "Qwen/Qwen3-32B": (4.00, 12.00),
}

# ASR 单价（元 / 秒）。免费模型显式写 0，与“未配置单价”区分开
ASR_PRICES: dict[str, float] = {
    "XingChenAGI/XingChenASR-V3.2": 0.0,
    "XingChenAGI/XingChenASR-V3.2-Ultra": 0.0,
    "XingChenAGI/XingChenASR-Diarize-V3.0": 0.0,
    "XingChenAGI/XingChenGSR-V1.0": 0.0,
    "FunAudioLLM/SenseVoiceSmall": 0.0,
    "Qwen/Qwen3-ASR-1.7B": 0.00022,
}


def _usage_file() -> Path:
    return cfgmod.ensure_cache_dir() / "usage.jsonl"


def _merge_prices(config: dict | None) -> tuple[dict, dict]:
    """内置单价表叠加 config 里的 pricing 覆盖。"""
    llm_prices = dict(LLM_PRICES)
    asr_prices = dict(ASR_PRICES)
    pricing = (config or {}).get("pricing") or {}
    for model, pair in (pricing.get("llm") or {}).items():
        llm_prices[model] = (float(pair[0]), float(pair[1]))
    for model, price in (pricing.get("asr") or {}).items():
        asr_prices[model] = float(price)
    return llm_prices, asr_prices


def llm_cost(
    model: str, prompt_tokens: int, completion_tokens: int, config: dict | None = None
) -> tuple[float, bool]:
    """返回 (成本元, 是否命中单价表)。未配置单价的模型金额记 0。"""
    llm_prices, _ = _merge_prices(config)
    pair = llm_prices.get(model)
    if pair is None:
        return 0.0, False
    input_price, output_price = pair
    cost = prompt_tokens * input_price / 1_000_000 + completion_tokens * output_price / 1_000_000
    return round(cost, 6), True


def asr_cost(model: str, seconds: float, config: dict | None = None) -> tuple[float, bool]:
    """返回 (成本元, 是否命中单价表)。免费模型命中且金额为 0。"""
    _, asr_prices = _merge_prices(config)
    if model not in asr_prices:
        return 0.0, False
    return round(seconds * asr_prices[model], 6), True


class UsageCollector:
    """单次运行内汇总 LLM/ASR 用量，结束后落一条明细。"""

    def __init__(self, config: dict, bvid: str, title: str) -> None:
        self.config = config
        self.bvid = bvid
        self.title = title
        self._lock = threading.Lock()
        self.llm_calls = 0
        self.llm_by_model: dict[str, dict] = {}
        self.asr_by_model: dict[str, float] = {}

    def record_llm(self, usage: dict) -> None:
        model = usage.get("model") or "unknown"
        prompt = int(usage.get("prompt_tokens", 0))
        completion = int(usage.get("completion_tokens", 0))
        with self._lock:
            bucket = self.llm_by_model.setdefault(
                model, {"calls": 0, "prompt_tokens": 0, "completion_tokens": 0}
            )
            bucket["calls"] += 1
            bucket["prompt_tokens"] += prompt
            bucket["completion_tokens"] += completion
            self.llm_calls += 1

    def record_asr(self, model: str, seconds: float) -> None:
        with self._lock:
            self.asr_by_model[model] = self.asr_by_model.get(model, 0.0) + seconds

    def build_record(self) -> dict:
        llm_items, unknown_llm = [], []
        llm_total = 0.0
        for model, bucket in sorted(self.llm_by_model.items()):
            cost, known = llm_cost(
                model,
                bucket["prompt_tokens"],
                bucket["completion_tokens"],
                self.config,
            )
            llm_total += cost
            item = {"model": model, **bucket, "cost": round(cost, 6)}
            (llm_items if known else unknown_llm).append(item)

        asr_items, unknown_asr = [], []
        asr_total = 0.0
        for model, seconds in sorted(self.asr_by_model.items()):
            cost, known = asr_cost(model, seconds, self.config)
            asr_total += cost
            item = {"model": model, "seconds": round(seconds, 2), "cost": round(cost, 6)}
            (asr_items if known else unknown_asr).append(item)

        return {
            "ts": datetime.now().isoformat(timespec="seconds"),
            "bvid": self.bvid,
            "title": self.title,
            "llm": {"items": llm_items, "unknown": unknown_llm, "cost": round(llm_total, 6)},
            "asr": {"items": asr_items, "unknown": unknown_asr, "cost": round(asr_total, 6)},
            "total": round(llm_total + asr_total, 6),
        }

    def save(self) -> dict:
        record = self.build_record()
        path = _usage_file()
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")
        return record


def load_records() -> list[dict]:
    path = _usage_file()
    if not path.exists():
        return []
    records = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            records.append(json.loads(line))
    return records


def reset() -> Path:
    path = _usage_file()
    if path.exists():
        path.unlink()
    return path


def format_totals(config: dict | None = None) -> str:
    """聚合全部明细：按模型累加 token/秒数与成本。"""
    records = load_records()
    if not records:
        return f"暂无成本记录（文件：{_usage_file()}）"

    llm_agg: dict[str, dict] = {}
    asr_agg: dict[str, dict] = {}
    grand_total = 0.0

    for record in records:
        grand_total += record.get("total", 0.0)
        for item in record.get("llm", {}).get("items", []):
            bucket = llm_agg.setdefault(
                item["model"],
                {"calls": 0, "prompt_tokens": 0, "completion_tokens": 0, "cost": 0.0},
            )
            bucket["calls"] += item["calls"]
            bucket["prompt_tokens"] += item["prompt_tokens"]
            bucket["completion_tokens"] += item["completion_tokens"]
            bucket["cost"] += item["cost"]
        for item in record.get("asr", {}).get("items", []):
            bucket = asr_agg.setdefault(
                item["model"], {"seconds": 0.0, "cost": 0.0}
            )
            bucket["seconds"] += item["seconds"]
            bucket["cost"] += item["cost"]

    lines = [f"共 {len(records)} 次运行，累计成本 ¥{grand_total:.4f}", ""]
    if llm_agg:
        lines.append("LLM（按模型）：")
        lines.append(f"  {'模型':<38}{'调用':>5}{'输入tok':>10}{'输出tok':>10}{'成本(元)':>10}")
        for model, b in sorted(llm_agg.items()):
            lines.append(
                f"  {model:<38}{b['calls']:>5}{b['prompt_tokens']:>10}"
                f"{b['completion_tokens']:>10}{b['cost']:>10.4f}"
            )
        lines.append("")
    if asr_agg:
        lines.append("ASR（按模型）：")
        lines.append(f"  {'模型':<38}{'秒数':>10}{'成本(元)':>10}")
        for model, b in sorted(asr_agg.items()):
            lines.append(f"  {model:<38}{b['seconds']:>10.1f}{b['cost']:>10.4f}")
        lines.append("")

    unknown = _unknown_models(records)
    if unknown:
        lines.append("以下模型未配置单价，按量记录但金额计 0（可用 pricing 配置补价）：")
        for model, kind in sorted(unknown):
            lines.append(f"  - [{kind}] {model}")
    lines.append(f"\n明细文件：{_usage_file()}")
    return "\n".join(lines)


def _unknown_models(records: list[dict]) -> set[tuple[str, str]]:
    unknown: set[tuple[str, str]] = set()
    for record in records:
        for item in record.get("llm", {}).get("unknown", []):
            unknown.add((item["model"], "LLM"))
        for item in record.get("asr", {}).get("unknown", []):
            unknown.add((item["model"], "ASR"))
    return unknown


def make_llm_sink(collector: "UsageCollector | None") -> Callable[[dict], None] | None:
    if collector is None:
        return None
    return collector.record_llm
