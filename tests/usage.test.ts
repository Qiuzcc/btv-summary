import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  UsageCollector,
  aggregate,
  asrCost,
  loadRecords,
  llmCost,
  resetRecords
} from '../src/main/core/usage'
import { DEFAULT_CONFIG, type AppConfig } from '../src/main/core/config'

let dir: string
beforeEach(() => {
  dir = join(tmpdir(), 'btv-usage-' + Math.random().toString(36).slice(2, 8))
  mkdirSync(dir, { recursive: true })
  process.env['BTV_USERDATA'] = dir
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env['BTV_USERDATA']
})

describe('单价计算', () => {
  it('LLM 命中单价表按 token 计', () => {
    const [cost, known] = llmCost('deepseek-ai/DeepSeek-V3.2', 1_000_000, 500_000)
    expect(known).toBe(true)
    // 4.0 + 6.0*0.5 = 7.0
    expect(cost).toBeCloseTo(7.0, 6)
  })

  it('LLM 未配置单价金额 0 且 known=false', () => {
    const [cost, known] = llmCost('unknown-model', 1000, 1000)
    expect(known).toBe(false)
    expect(cost).toBe(0)
  })

  it('ASR 免费模型金额 0 但命中', () => {
    const [cost, known] = asrCost('XingChenAGI/XingChenASR-V3.2', 100)
    expect(known).toBe(true)
    expect(cost).toBe(0)
  })

  it('ASR 未配置单价金额 0 且 known=false', () => {
    const [cost, known] = asrCost('unknown-asr', 100)
    expect(known).toBe(false)
    expect(cost).toBe(0)
  })

  it('pricing 覆盖生效', () => {
    const cfg = structuredClone(DEFAULT_CONFIG) as AppConfig
    cfg.pricing.llm['custom-model'] = [10, 20]
    cfg.pricing.asr['custom-asr'] = 0.5
    expect(llmCost('custom-model', 1_000_000, 0, cfg)[0]).toBeCloseTo(10, 6)
    expect(asrCost('custom-asr', 10, cfg)[0]).toBeCloseTo(5, 6)
  })
})

describe('UsageCollector', () => {
  const config = structuredClone(DEFAULT_CONFIG) as AppConfig

  it('buildRecord 聚合 LLM 与 ASR，未知模型归入 unknown', () => {
    const collector = new UsageCollector(config, 'BV1', 'title')
    collector.recordLlm({ model: 'deepseek-ai/DeepSeek-V3.2', prompt_tokens: 1000, completion_tokens: 500 })
    collector.recordLlm({ model: 'unknown-llm', prompt_tokens: 100, completion_tokens: 50 })
    collector.recordAsr('XingChenAGI/XingChenASR-V3.2', 60)
    collector.recordAsr('unknown-asr', 30)

    const record = collector.buildRecord()
    expect(record.llm.items).toHaveLength(1)
    expect(record.llm.items[0].model).toBe('deepseek-ai/DeepSeek-V3.2')
    expect(record.llm.unknown).toHaveLength(1)
    expect(record.llm.unknown[0].cost).toBe(0)

    expect(record.asr.items).toHaveLength(1)
    expect(record.asr.items[0].cost).toBe(0) // 免费模型
    expect(record.asr.unknown).toHaveLength(1)

    expect(record.total).toBe(record.llm.cost + record.asr.cost)
  })

  it('save 写入 JSONL 且可回读', () => {
    const collector = new UsageCollector(config, 'BV1', 'title')
    collector.recordLlm({ model: 'deepseek-ai/DeepSeek-V3.2', prompt_tokens: 1000, completion_tokens: 500 })
    const record = collector.save()
    const records = loadRecords()
    expect(records).toHaveLength(1)
    expect(records[0].bvid).toBe('BV1')
    expect(record.total).toBe(records[0].total)
  })
})

describe('聚合', () => {
  it('aggregate 按模型累加并列出未知模型', () => {
    const config = structuredClone(DEFAULT_CONFIG) as AppConfig
    const c1 = new UsageCollector(config, 'BV1', 't1')
    c1.recordLlm({ model: 'deepseek-ai/DeepSeek-V3.2', prompt_tokens: 1000, completion_tokens: 500 })
    c1.recordAsr('unknown-asr', 30)
    c1.save()

    const c2 = new UsageCollector(config, 'BV2', 't2')
    c2.recordLlm({ model: 'deepseek-ai/DeepSeek-V3.2', prompt_tokens: 2000, completion_tokens: 1000 })
    c2.save()

    const agg = aggregate(loadRecords())
    expect(agg.count).toBe(2)
    expect(agg.llm['deepseek-ai/DeepSeek-V3.2'].calls).toBe(2)
    expect(agg.llm['deepseek-ai/DeepSeek-V3.2'].prompt_tokens).toBe(3000)
    expect(agg.unknown).toContainEqual({ model: 'unknown-asr', kind: 'ASR' })
  })

  it('resetRecords 删除明细文件', () => {
    const config = structuredClone(DEFAULT_CONFIG) as AppConfig
    new UsageCollector(config, 'BV1', 't').save()
    expect(existsSync(join(dir, 'cache', 'usage.jsonl'))).toBe(true)
    resetRecords()
    expect(existsSync(join(dir, 'cache', 'usage.jsonl'))).toBe(false)
  })
})
