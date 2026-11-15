/**
 * 成本统计：单价表、逐轮明细持久化与聚合。口径对齐 archive/btv/usage.py。
 * - LLM 成本 = 真实 token × 模型单价（元/百万 token）
 * - ASR 成本 = 音频秒数 × 每秒单价（元/秒）
 * 明细以 JSONL 追加；聚合只对明细累加。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AppConfig, UsageAggregate, UsageItem, UsageRecord } from '../../shared/types'
import { usageFile } from './paths'
import type { LlmUsage } from './llm'

// 硅基流动参考单价（2026-11，元 / 百万 token），可用 config.pricing 覆盖
export const LLM_PRICES: Record<string, [number, number]> = {
  'zai-org/GLM-5.3': [0.8, 2.8],
  'zai-org/GLM-5.3-Flash': [0.8, 2.8],
  'zai-org/GLM-4.5-Air': [1.0, 6.0],
  'deepseek-ai/DeepSeek-V4.1-Flash': [2.0, 8.0],
  'deepseek-ai/DeepSeek-V3.2': [4.0, 6.0],
  'deepseek-ai/DeepSeek-V4-Pro': [12.0, 24.0],
  'deepseek-ai/DeepSeek-R1': [8.0, 16.0],
  'Qwen/Qwen2.5-72B-Instruct': [0.7, 1.4],
  'Qwen/Qwen3-32B': [4.0, 12.0]
}

// ASR 单价（元 / 秒）。免费模型显式 0，与“未配置单价”区分
export const ASR_PRICES: Record<string, number> = {
  'XingChenAGI/XingChenASR-V3.2': 0.0,
  'XingChenAGI/XingChenASR-V3.2-Ultra': 0.0,
  'XingChenAGI/XingChenASR-Diarize-V3.0': 0.0,
  'XingChenAGI/XingChenGSR-V1.0': 0.0,
  'FunAudioLLM/SenseVoiceSmall': 0.0,
  'Qwen/Qwen3-ASR-1.7B': 0.00022
}

function mergePrices(config: AppConfig | null): {
  llm: Record<string, [number, number]>
  asr: Record<string, number>
} {
  const llm = { ...LLM_PRICES }
  const asr = { ...ASR_PRICES }
  const pricing = config?.pricing
  for (const [model, pair] of Object.entries(pricing?.llm ?? {})) {
    llm[model] = [Number(pair[0]), Number(pair[1])]
  }
  for (const [model, price] of Object.entries(pricing?.asr ?? {})) {
    asr[model] = Number(price)
  }
  return { llm, asr }
}

/** 返回 (成本元, 是否命中单价表)。未配置单价的模型金额记 0。 */
export function llmCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
  config: AppConfig | null = null
): [number, boolean] {
  const pair = mergePrices(config).llm[model]
  if (pair === undefined) return [0, false]
  const [inputPrice, outputPrice] = pair
  const cost = (promptTokens * inputPrice) / 1_000_000 + (completionTokens * outputPrice) / 1_000_000
  return [Math.round(cost * 1e6) / 1e6, true]
}

/** 返回 (成本元, 是否命中单价表)。免费模型命中且金额为 0。 */
export function asrCost(model: string, seconds: number, config: AppConfig | null = null): [number, boolean] {
  const prices = mergePrices(config).asr
  if (!(model in prices)) return [0, false]
  return [Math.round(seconds * prices[model] * 1e6) / 1e6, true]
}

interface LlmBucket {
  calls: number
  prompt_tokens: number
  completion_tokens: number
}

/** 单次运行内汇总 LLM/ASR 用量，结束后落一条明细。 */
export class UsageCollector {
  private llmByModel = new Map<string, LlmBucket>()
  private asrByModel = new Map<string, number>()
  private llmCalls = 0

  constructor(
    private readonly config: AppConfig,
    public bvid: string,
    public title: string
  ) {}

  recordLlm(usage: LlmUsage): void {
    const model = usage.model || 'unknown'
    const prompt = Math.trunc(usage.prompt_tokens || 0)
    const completion = Math.trunc(usage.completion_tokens || 0)
    const bucket = this.llmByModel.get(model) ?? { calls: 0, prompt_tokens: 0, completion_tokens: 0 }
    bucket.calls += 1
    bucket.prompt_tokens += prompt
    bucket.completion_tokens += completion
    this.llmByModel.set(model, bucket)
    this.llmCalls += 1
  }

  recordAsr(model: string, seconds: number): void {
    this.asrByModel.set(model, (this.asrByModel.get(model) ?? 0) + seconds)
  }

  buildRecord(): UsageRecord {
    const llmItems: UsageItem[] = []
    const unknownLlm: UsageItem[] = []
    let llmTotal = 0
    for (const [model, bucket] of [...this.llmByModel.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const [cost, known] = llmCost(model, bucket.prompt_tokens, bucket.completion_tokens, this.config)
      llmTotal += cost
      const item: UsageItem = { model, calls: bucket.calls, prompt_tokens: bucket.prompt_tokens, completion_tokens: bucket.completion_tokens, cost: Math.round(cost * 1e6) / 1e6 }
      ;(known ? llmItems : unknownLlm).push(item)
    }

    const asrItems: UsageItem[] = []
    const unknownAsr: UsageItem[] = []
    let asrTotal = 0
    for (const [model, seconds] of [...this.asrByModel.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const [cost, known] = asrCost(model, seconds, this.config)
      asrTotal += cost
      const item: UsageItem = { model, seconds: Math.round(seconds * 100) / 100, cost: Math.round(cost * 1e6) / 1e6 }
      ;(known ? asrItems : unknownAsr).push(item)
    }

    return {
      ts: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      bvid: this.bvid,
      title: this.title,
      llm: { items: llmItems, unknown: unknownLlm, cost: Math.round(llmTotal * 1e6) / 1e6 },
      asr: { items: asrItems, unknown: unknownAsr, cost: Math.round(asrTotal * 1e6) / 1e6 },
      total: Math.round((llmTotal + asrTotal) * 1e6) / 1e6
    }
  }

  /** 串行追加一条 JSONL 明细，避免多任务并发行交错 */
  save(): UsageRecord {
    const record = this.buildRecord()
    const path = usageFile()
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, JSON.stringify(record) + '\n', 'utf8')
    return record
  }

  get calls(): number {
    return this.llmCalls
  }

  get hasAsr(): boolean {
    return this.asrByModel.size > 0
  }
}

export function loadRecords(): UsageRecord[] {
  const path = usageFile()
  if (!existsSync(path)) return []
  const records: UsageRecord[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (trimmed) {
      try {
        records.push(JSON.parse(trimmed) as UsageRecord)
      } catch {
        // 跳过损坏行
      }
    }
  }
  return records
}

export function resetRecords(): string {
  const path = usageFile()
  if (existsSync(path)) unlinkSync(path)
  return path
}

export function aggregate(records: UsageRecord[]): UsageAggregate {
  const agg: UsageAggregate = {
    count: records.length,
    grandTotal: 0,
    llm: {},
    asr: {},
    unknown: []
  }
  const unknownSet = new Set<string>()
  for (const record of records) {
    agg.grandTotal += record.total || 0
    for (const item of record.llm?.items ?? []) {
      const bucket = agg.llm[item.model] ?? { calls: 0, prompt_tokens: 0, completion_tokens: 0, cost: 0 }
      bucket.calls += item.calls ?? 0
      bucket.prompt_tokens += item.prompt_tokens ?? 0
      bucket.completion_tokens += item.completion_tokens ?? 0
      bucket.cost += item.cost
      agg.llm[item.model] = bucket
    }
    for (const item of record.asr?.items ?? []) {
      const bucket = agg.asr[item.model] ?? { seconds: 0, cost: 0 }
      bucket.seconds += item.seconds ?? 0
      bucket.cost += item.cost
      agg.asr[item.model] = bucket
    }
    for (const item of record.llm?.unknown ?? []) {
      const key = `LLM:${item.model}`
      if (!unknownSet.has(key)) { unknownSet.add(key); agg.unknown.push({ model: item.model, kind: 'LLM' }) }
    }
    for (const item of record.asr?.unknown ?? []) {
      const key = `ASR:${item.model}`
      if (!unknownSet.has(key)) { unknownSet.add(key); agg.unknown.push({ model: item.model, kind: 'ASR' }) }
    }
  }
  return agg
}

/** 仅供测试写固定明细（绕过 collector） */
export function _appendRecordForTest(record: UsageRecord): void {
  const path = usageFile()
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, JSON.stringify(record) + '\n', 'utf8')
}
