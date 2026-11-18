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

describe('TR-9.1 提示词常量', () => {
  it('DETAILS 三档参数一致', () => {
    expect(DETAILS.brief).toEqual({ chunk_seconds: 720, min_bullets: 2, max_bullets: 4 })
    expect(DETAILS.normal).toEqual({ chunk_seconds: 480, min_bullets: 3, max_bullets: 6 })
    expect(DETAILS.deep).toEqual({ chunk_seconds: 300, min_bullets: 4, max_bullets: 8 })
    expect(KEY_POINTS_MAX_CHARS).toBe(500)
  })

  it('MAP_SYSTEM 内容稳定', () => {
    expect(MAP_SYSTEM).toBe(
      '你是严谨的视频内容提炼助手，只依据给定的转写文本工作，不补充转写中没有出现的信息。'
    )
  })
  it('MAP_USER 内容稳定', () => {
    expect(MAP_USER).toBe(`以下是视频《{title}》第 {index}/{total} 段的转写，时间范围 {start} 到 {end}。
请提炼这一段的要点，用 {min_bullets} 到 {max_bullets} 条 Markdown 列表输出。
每条以 [mm:ss] 开头，对应该要点出现的时间；只写要点，不要开场白，不要概括本段之外的内容。

转写：
{body}
`)
  })
  it('REDUCE_SYSTEM 内容稳定', () => {
    expect(REDUCE_SYSTEM).toBe(
      '你是资深内容编辑，负责把分段笔记整合成一篇可读的视频摘要。' +
        '只使用笔记中的信息，不要编造，不要输出与笔记无关的评价。'
    )
  })
  it('REDUCE_USER 内容稳定', () => {
    expect(REDUCE_USER).toBe(`视频信息：
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
`)
  })
  it('COMPRESS_KEY_POINTS_USER 内容稳定', () => {
    expect(COMPRESS_KEY_POINTS_USER).toBe(`下面是视频笔记的「核心要点」章节，当前约 {current} 字，超过 {limit} 字的上限。
请压缩改写，使全章总字数不超过 {limit} 字，要求：
- 保持 5 条编号列表，按重要性排序，每条只保留一个核心结论；
- 保留关键数字、专有名词和结论，删去修饰语、重复举例和括号补充；
- 只输出压缩后的 5 条列表，不要标题、开场白或其他章节，不要编造信息。

原文：
{body}
`)
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
    const md = await summarize(transcript, config, { llmChat, chunkSeconds: 5 })
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
    // 单次总结返回超限正文 → 压缩返回更长内容（无效）
    const llmChat = vi.fn(async (_config, messages) => {
      const user = messages[messages.length - 1].content as string
      if (user.includes('压缩改写')) return `1. ${'啊'.repeat(800)}`
      return `# 测试视频\n\n## TL;DR\nx\n\n## 核心要点\n${longBody}\n\n## 值得追问\n- q`
    })
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

describe('TR-9.3 单次总结与超限回退', () => {
  const config = structuredClone(DEFAULT_CONFIG) as AppConfig
  config.llm.api_key = 'sk-x'
  config.llm.base_url = 'https://x'

  type Msg = { role: string; content: string }

  it('全文未超上限时只调用一次 LLM', async () => {
    const llmChat = vi.fn(async (_cfg: AppConfig, _messages: Msg[]) => '# 测试视频\n\n## TL;DR\n摘要')
    const transcript = makeTranscript([
      { start: 0, end: 10, text: '第一段' },
      { start: 10, end: 20, text: '第二段' }
    ])
    await summarize(transcript, config, { llmChat })
    expect(llmChat).toHaveBeenCalledTimes(1)
    const user = llmChat.mock.calls[0][1][1].content
    expect(user).toContain('完整转写')
    expect(user).toContain('[00:00] 第一段')
    expect(user).not.toContain('{body}')
    expect(user).not.toContain('{url}')
  })

  it('全文超出上限时退回 Map-Reduce', async () => {
    const tiny = structuredClone(config) as AppConfig
    tiny.llm.max_input_chars = 10
    const llmChat = vi.fn(async (_cfg: AppConfig, messages: Msg[]) => {
      const user = messages[messages.length - 1].content
      return user.includes('请提炼这一段')
        ? '- [00:00] 要点'
        : '# 测试视频\n\n## TL;DR\n摘要'
    })
    const transcript = makeTranscript([
      { start: 0, end: 10, text: '第一段' },
      { start: 10, end: 20, text: '第二段' }
    ])
    await summarize(transcript, tiny, { llmChat })
    expect(llmChat.mock.calls.length).toBeGreaterThan(1)
    const first = llmChat.mock.calls[0][1][1].content
    expect(first).toContain('请提炼这一段')
  })

  it('显式指定 chunkSeconds 时保持分块', async () => {
    const llmChat = vi.fn(async (_cfg: AppConfig, messages: Msg[]) => {
      const user = messages[messages.length - 1].content
      return user.includes('请提炼这一段')
        ? '- [00:00] 要点'
        : '# 测试视频\n\n## TL;DR\n摘要'
    })
    const transcript = makeTranscript([
      { start: 0, end: 10, text: '第一段' },
      { start: 10, end: 20, text: '第二段' }
    ])
    await summarize(transcript, config, { llmChat, chunkSeconds: 5 })
    expect(llmChat.mock.calls.length).toBe(3)
  })
})
