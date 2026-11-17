import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { transcribe, transcribeCloud } from '../src/main/core/asr'
import { DEFAULT_CONFIG, type AppConfig } from '../src/main/core/config'

let dir: string
let audioPath: string

beforeEach(() => {
  dir = join(tmpdir(), 'btv-asr-' + Math.random().toString(36).slice(2, 8))
  mkdirSync(dir, { recursive: true })
  audioPath = join(dir, 'audio.mp3')
  writeFileSync(audioPath, Buffer.from('fake'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('ASR 模块', () => {
  it('TR-8.2 缺 base_url 或 api_key 立即报错', async () => {
    await expect(
      transcribeCloud(audioPath, '', 'key', 'm')
    ).rejects.toThrow(/云端转写需要配置/)
    await expect(
      transcribeCloud(audioPath, 'https://x', '', 'm')
    ).rejects.toThrow(/云端转写需要配置/)
  })

  it('标准分段解析', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          segments: [
            { start: 0, end: 1.5, text: '你好' },
            { start: 1.5, end: 3, text: '世界' }
          ]
        }),
        { status: 200 }
      )
    )
    const segs = await transcribeCloud(audioPath, 'https://x', 'k', 'm', '', { fetchImpl })
    expect(segs).toHaveLength(2)
    expect(segs[0]).toEqual({ start: 0, end: 1.5, text: '你好' })
  })

  it('仅 text 时降级单段', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: '只有文本' }), { status: 200 })
    )
    const segs = await transcribeCloud(audioPath, 'https://x', 'k', 'm', '', { fetchImpl })
    expect(segs).toEqual([{ start: 0, end: 0, text: '只有文本' }])
  })

  it('空文本报错', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ segments: [] }), { status: 200 })
    )
    await expect(
      transcribeCloud(audioPath, 'https://x', 'k', 'm', '', { fetchImpl })
    ).rejects.toThrow(/没有返回文本/)
  })

  it('HTTP 错误截取响应文案', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('bad request detail', { status: 400 })
    )
    await expect(
      transcribeCloud(audioPath, 'https://x', 'k', 'm', '', { fetchImpl })
    ).rejects.toThrow(/云端转写失败 400：bad request detail/)
  })

  it('transcribe 读取配置并返回分段', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ segments: [{ start: 0, end: 12.5, text: 'x' }] }),
        { status: 200 }
      )
    )
    const cfg = structuredClone(DEFAULT_CONFIG) as AppConfig
    cfg.cloud_asr.base_url = 'https://x'
    cfg.cloud_asr.api_key = 'k'
    cfg.cloud_asr.model = 'XingChenAGI/XingChenASR-Diarize-V3.0'
    const segs = await transcribe(audioPath, cfg, { fetchImpl })
    expect(segs).toHaveLength(1)
    expect(segs[0]).toEqual({ start: 0, end: 12.5, text: 'x' })
  })
})
