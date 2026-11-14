# btv-summary

B 站长视频要点提炼工具：**字幕优先 → 云端 ASR 兜底 → LLM 分块总结**，输出带时间戳跳转链接的 Markdown 笔记。

## 安装

需要 Python 3.10+ 和系统 `ffmpeg`。

```bash
python3.14 -m venv .venv
source .venv/bin/activate
pip install -e .
```

## 配置

配置文件：`~/.config/btv/config.json`（权限 600）。

### 1. B 站登录态（可选，用于拿高清字幕）

```bash
btv login --cookie "你的 SESSDATA 或完整 Cookie 字符串"
```

不登录也能用，会自动走音频转写。

### 2. LLM（总结用）

以硅基流动为例（一个 key 同时覆盖 ASR + LLM）：

```bash
btv config set llm.base_url https://api.siliconflow.cn/v1
btv config set llm.api_key  <你的 API Key>
btv config set llm.model Qwen/Qwen2.5-7B-Instruct
```

网络抖动、429 限流或 5xx 会自动指数退避重试（默认 3 次，可用 `btv config set llm.max_retries N` 调整）；单块内容重试耗尽后用原始转写降级，不会中断整次总结。

### 3. ASR（无字幕时云端转写音频）

```bash
btv config set cloud_asr.base_url https://api.siliconflow.cn/v1
btv config set cloud_asr.api_key  <你的 API Key>
# 默认为 XingChenASR-Diarize-V3.0（免费、带时间戳、速度快），无需额外设置
btv config set cloud_asr.model XingChenAGI/XingChenASR-Diarize-V3.0
```

音频统一转成 64kbps 单声道 MP3 再上传（比 WAV 小约 4/5），实测 47 分钟音频转写约 70 秒。
备选免费模型：`XingChenAGI/XingChenASR-V3.2-Ultra`（更准但慢约 3 倍）；`FunAudioLLM/SenseVoiceSmall` 不返回分段时间戳，不适用。

查看配置（密钥自动打码）：`btv config show`

## 使用

```bash
# 生成总结笔记（默认输出 out/<视频标题>/summary.md）
btv summarize <BV号或链接>

# 跳过字幕，直接云端转写
btv summarize <链接> --no-subtitle

# 只要字幕/转写，不总结
btv subtitle <链接>

# 查看累计成本（LLM token + ASR 秒数），--reset 可清空
btv usage

# 更细的分块、更深的总结
btv summarize <链接> --detail deep --chunk-seconds 300
```

### 常用参数

| 参数 | 说明 |
|------|------|
| `--no-subtitle` | 跳过 B 站字幕，直接转写 |
| `--refresh` | 忽略缓存，重新获取 |
| `--detail brief\|normal\|deep` | 总结详细程度 |
| `--chunk-seconds N` | 每块时长（秒） |
| `--model NAME` | 临时覆盖 LLM 模型 |
| `-o PATH` | 输出路径 |

## 输出

默认目录 `out/<视频标题>/`（标题中的非法文件名字符会替换为 `_`，超长截断 80 字；`-o` 可自定义路径）：

```
out/<视频标题>/
├── summary.md        # summarize 产出
├── transcript.srt    # subtitle 产出（带时间戳）
└── transcript.json
```

Markdown 笔记结构：

```
# 标题
> 来源：链接 · 时长 · UP 主

## TL;DR
## 章节          ← 每个章节标题是可点击的时间戳链接（?t=秒数）
## 核心要点
## 术语与金句
## 值得追问
```

缓存：`~/.cache/btv/<BV号>/`（audio.mp3 + transcript.json），按 BV 号存储，与输出目录无关。

## 成本统计

每次运行结束打印本轮成本，并把明细追加到 `~/.cache/btv/usage.jsonl`：

```bash
btv usage          # 按模型聚合：LLM token 数与金额、ASR 秒数与金额
btv usage --reset  # 清空明细
```

- LLM 按响应真实返回的 token 用量 × 模型单价（元/百万 token）；ASR 按音频秒数 × 每秒单价，免费模型记 0。
- 内置硅基流动常用模型参考单价（2026-11），可在配置里覆盖或补充新模型：

```bash
btv config set pricing.llm.deepseek-ai/DeepSeek-V3.2 '["4.0","6.0"]'
btv config set pricing.asr.Qwen/Qwen3-ASR-1.7B 0.00022
```

未配置单价的模型仍记录用量，但金额计 0 并在 `btv usage` 中列出提示。
