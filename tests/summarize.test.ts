import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  COMPRESS_KEY_POINTS_USER,
  DETAILS,
  KEY_POINTS_MAX_CHARS,
  MAP_SYSTEM,
  MAP_USER,
  REDUCE_SYSTEM,
  REDUCE_USER,
  summarize,
  stripCodeFence
} from '../src/main/core/summarize'
import { DEFAULT_CONFIG, type AppConfig } from '../src/main/core/config'
import type { Transcript } from '../src/shared/types'

const PY_FILE = join(import.meta.dirname, '../archive/btv/summarize.py')
const pySource = readFileSync(PY_FILE, 'utf8')

function extractPythonConstant(name: string): string {
  const startRe = new RegExp(`${name}\\s*=\\s*`)
  const startMatch = pySource.match(startRe)
  if (!startMatch || startMatch.index === undefined) {
    throw new Error(`未在 summarize.py 找到常量 ${name}`)
  }
  let pos = startMatch.index + startMatch[0].length
  const parts: string[] = []
  // 反复匹配 Python 字符串（双引号或三引号），若紧随 + 则继续拼接
  while (true) {
    while (pos < pySource.length && /\s/.test(pySource[pos])) pos++
    if (pySource[pos] === '(') { pos++; continue }
    const open = pos
    const isTriple = pySource.startsWith('"""', open)
    if (pySource[open] !== '"') break
    let close: number
    if (isTriple) {
      close = pySource.indexOf('"""', open + 3)
      if (close === -1) break
      parts.push(pySource.slice(open + 3, close))
      pos = close + 3
    } else {
      // 单引号字符串：找下一个未转义的 "
      let i = open + 1
      while (i < pySource.length) {
        if (pySource[i] === '\\') { i += 2; continue }
        if (pySource[i] === '"') break
        i++
      }
      if (i >= pySource.length) break
      parts.push(pySource.slice(open + 1, i))
      pos = i + 1
    }
    while (pos < pySource.length && /\s/.test(pySource[pos])) pos++
    if (pySource[pos] === '+') { pos++; continue }
    if (pySource[pos] === '"') continue // Python 隐式字符串拼接
    break
  }
  if (parts.length === 0) throw new Error(`常量 ${name} 无可拼接的字符串`)
  return parts.join('')
}

describe('TR-9.1 提示词常量与 Python 逐字一致', () => {
  it('DETAILS 三档参数一致', () => {
    expect(DETAILS.brief).toEqual({ chunk_seconds: 720, min_bullets: 2, max_bullets: 4 })
    expect(DETAILS.normal).toEqual({ chunk_seconds: 480, min_bullets: 3, max_bullets: 6 })
    expect(DETAILS.deep).toEqual({ chunk_seconds: 300, min_bullets: 4, max_bullets: 8 })
    expect(KEY_POINTS_MAX_CHARS).toBe(500)
  })

  it('MAP_SYSTEM 逐字一致', () => {
    expect(MAP_SYSTEM).toBe(extractPythonConstant('MAP_SYSTEM'))
  })
  it('MAP_USER 逐字一致', () => {
    expect(MAP_USER).toBe(extractPythonConstant('MAP_USER'))
  })
  it('REDUCE_SYSTEM 逐字一致', () => {
    expect(REDUCE_SYSTEM).toBe(extractPythonConstant('REDUCE_SYSTEM'))
  })
  it('REDUCE_USER 逐字一致', () => {
    expect(REDUCE_USER).toBe(extractPythonConstant('REDUCE_USER'))
  })
  it('COMPRESS_KEY_POINTS_USER 逐字一致', () => {
    expect(COMPRESS_KEY_POINTS_USER).toBe(extractPythonConstant('COMPRESS_KEY_POINTS_USER'))
  })
})

function makeTranscript(segments: Array<{ start: number; end: number; text: string }>): Transcript {
  return {
    bvid: 'BV1TEST12345',
    title: '测试视频',
    owner: 'UP',
    duration: 60,
    source: 'asr',
    segments
  }
}

describe('TR-9.2 summarize 各路径', () => {
  const config = structuredClone(DEFAULT_CONFIG) as AppConfig
  config.llm.api_key = 'sk-x'
  config.llm.base_url = 'https://x'

  it('全成功产出完整 Markdown 结构', async () => {
    const fullMd = `# 测试视频

> 来源：x

## TL;DR
核心结论

## 核心要点
1. 要点一
2. 要点二

## 值得追问
- 问题`
    const llmChat = vi.fn(async (_cfg, messages) => {
      const user = messages[messages.length - 1].content as string
      return user.includes('请输出一篇中文 Markdown') ? fullMd : '分段要点'
    })
    const transcript = makeTranscript([
      { start: 0, end: 10, text: '第一段' },
      { start: 10, end: 20, text: '第二段' }
    ])
    const md = await summarize(transcript, config, { llmChat, chunkSeconds: 5 })
    expect(md).toContain('# 测试视频')
    expect(md).toContain('## TL;DR')
    expect(md).toContain('## 核心要点')
    expect(md).toContain('## 值得追问')
    expect(md.endsWith('## 原始转写\n\n第一段\n第二段')).toBe(true)
    // map 调用 2 次 + reduce 1 次
    expect(llmChat).toHaveBeenCalledTimes(3)
  })

  it('字幕来源在末尾追加原始字幕', async () => {
    const llmChat = vi.fn(async (_cfg, messages) => {
      const user = messages[messages.length - 1].content as string
      return user.includes('请输出一篇中文 Markdown') ? '# 测试视频\n\n## TL;DR\n摘要' : '分段要点'
    })
    const transcript = makeTranscript([{ start: 0, end: 10, text: '字幕原文' }])
    transcript.source = 'subtitle'
    const md = await summarize(transcript, config, { llmChat })
    expect(md.endsWith('## 原始字幕\n\n字幕原文')).toBe(true)
  })

  it('单块失败用带时间戳原文降级', async () => {
    const llmChat = vi.fn(async (_config, messages) => {
      const user = messages[messages.length - 1].content as string
      // map 阶段失败，reduce 阶段回传原始 notes
      if (user.includes('请提炼这一段')) throw new Error('块失败')
      return user // reduce 直接回显 notes
    })
    const transcript = makeTranscript([
      { start: 0, end: 10, text: '第一段' },
      { start: 10, end: 20, text: '第二段' }
    ])
    const md = await summarize(transcript, config, { llmChat })
    expect(md).toContain('[00:00] 第一段')
  })

  it('代码围栏剥离', () => {
    expect(stripCodeFence('```markdown\n# title\n```')).toBe('# title')
    expect(stripCodeFence('```\nbody\n```')).toBe('body')
    expect(stripCodeFence('plain')).toBe('plain')
  })

  it('核心要点超限触发压缩且生效', async () => {
    const longBody = '1. ' + '啊'.repeat(600)
    const llmChat = vi.fn(async (_config, messages) => {
      const user = messages[messages.length - 1].content as string
      if (user.includes('压缩改写')) {
        return '1. 短' // 压缩后更短
      }
      return `# 测试视频\n\n## TL;DR\nx\n\n## 核心要点\n${longBody}\n\n## 值得追问\n- q`
    })
    const transcript = makeTranscript([{ start: 0, end: 10, text: 'x' }])
    const md = await summarize(transcript, config, { llmChat })
    expect(md).toContain('1. 短')
    expect(md).not.toContain('啊')
  })

  it('压缩无效保留原文', async () => {
    const longBody = '1. ' + '啊'.repeat(600)
    const transcript = makeTranscript([{ start: 0, end: 10, text: 'x' }])
    // map → reduce(长文) → compress(更长，无效)
    const llmChat = vi.fn()
      .mockResolvedValueOnce('map note')
      .mockResolvedValueOnce(`# 测试视频\n\n## TL;DR\nx\n\n## 核心要点\n${longBody}\n\n## 值得追问\n- q`)
      .mockResolvedValueOnce(`1. ${'啊'.repeat(800)}`)
    const md = await summarize(transcript, config, { llmChat })
    expect(md).toContain('啊')
  })

  it('缺失一级标题自动补全', async () => {
    const llmChat = vi.fn().mockResolvedValue('没有任何标题的正文')
    const transcript = makeTranscript([{ start: 0, end: 10, text: 'x' }])
    const md = await summarize(transcript, config, { llmChat })
    expect(md.startsWith('# 测试视频')).toBe(true)
  })

  it('空转写报错', async () => {
    const llmChat = vi.fn()
    const transcript = makeTranscript([])
    await expect(summarize(transcript, config, { llmChat })).rejects.toThrow(/转写内容为空/)
  })
})
