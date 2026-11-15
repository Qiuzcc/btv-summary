/**
 * 总结引擎：map-reduce + 核心要点字数硬上限定向压缩。
 * 提示词常量与 archive/btv/summarize.py 逐字一致；流程、降级、后处理对齐。
 */
import type { AppConfig } from './config'
import { chat, type ChatMessage, type LlmUsage } from './llm'
import { chunkSegments, formatTs } from '../../shared/transcript'
import type { Segment, Transcript } from '../../shared/types'

export const DETAILS: Record<string, { chunk_seconds: number; min_bullets: number; max_bullets: number }> = {
  brief: { chunk_seconds: 720, min_bullets: 2, max_bullets: 4 },
  normal: { chunk_seconds: 480, min_bullets: 3, max_bullets: 6 },
  deep: { chunk_seconds: 300, min_bullets: 4, max_bullets: 8 }
}

/** 核心要点全章字数硬上限（提示词软约束之外的代码兜底） */
export const KEY_POINTS_MAX_CHARS = 500

// 对齐 Python：(^## 核心要点\s*\n)(.*?)(?=\n## |\Z)，MULTILINE | DOTALL
// JS 用 [\s\S]*? 代替 DOTALL，/d 取 group 2 的 start/end 以支持区间替换
const KEY_POINTS_SECTION_RE = /(^## 核心要点\s*\n)([\s\S]*?)(?=\n## |$)/md

export const MAP_SYSTEM =
  '你是严谨的视频内容提炼助手，只依据给定的转写文本工作，' +
  '不补充转写中没有出现的信息。'

export const MAP_USER = `以下是视频《{title}》第 {index}/{total} 段的转写，时间范围 {start} 到 {end}。
请提炼这一段的要点，用 {min_bullets} 到 {max_bullets} 条 Markdown 列表输出。
每条以 [mm:ss] 开头，对应该要点出现的时间；只写要点，不要开场白，不要概括本段之外的内容。

转写：
{body}
`

export const REDUCE_SYSTEM =
  '你是资深内容编辑，负责把分段笔记整合成一篇可读的视频摘要。' +
  '只使用笔记中的信息，不要编造，不要输出与笔记无关的评价。'

export const REDUCE_USER = `视频信息：
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
`

export const COMPRESS_KEY_POINTS_USER = `下面是视频笔记的「核心要点」章节，当前约 {current} 字，超过 {limit} 字的上限。
请压缩改写，使全章总字数不超过 {limit} 字，要求：
- 保持 5 条编号列表，按重要性排序，每条只保留一个核心结论；
- 保留关键数字、专有名词和结论，删去修饰语、重复举例和括号补充；
- 只输出压缩后的 5 条列表，不要标题、开场白或其他章节，不要编造信息。

原文：
{body}
`

export interface SummarizeOptions {
  detail?: string
  chunkSeconds?: number | null
  progress?: (message: string) => void
  onUsage?: (usage: LlmUsage) => void
  /** 注入 LLM 调用，便于单测；默认使用 llm.chat */
  llmChat?: typeof chat
}

async function mapChunk(
  config: AppConfig,
  settings: { chunk_seconds: number; min_bullets: number; max_bullets: number },
  title: string,
  total: number,
  index: number,
  chunk: Segment[],
  llmChat: typeof chat,
  onUsage?: (usage: LlmUsage) => void
): Promise<string> {
  const body = chunk
    .map((segment) => `[${formatTs(segment.start)}] ${segment.text}`)
    .join('\n')
  return llmChat(
    config,
    [
      { role: 'system', content: MAP_SYSTEM },
      {
        role: 'user',
        content: MAP_USER
          .replace('{title}', title)
          .replace('{index}', String(index))
          .replace('{total}', String(total))
          .replace('{start}', formatTs(chunk[0].start))
          .replace('{end}', formatTs(chunk[chunk.length - 1].end))
          .replace('{min_bullets}', String(settings.min_bullets))
          .replace('{max_bullets}', String(settings.max_bullets))
          .replace('{body}', body)
      }
    ],
    { onUsage }
  )
}

export async function summarize(
  transcript: Transcript,
  config: AppConfig,
  options: SummarizeOptions = {}
): Promise<string> {
  const progress = options.progress ?? (() => {})
  if (!transcript.segments || transcript.segments.length === 0) {
    throw new Error('转写内容为空，无法总结')
  }

  const detail = options.detail ?? 'normal'
  const settings = DETAILS[detail] ?? DETAILS.normal
  const targetSeconds = options.chunkSeconds ?? settings.chunk_seconds
  const maxChars = Math.trunc(config.llm.max_chars || 6000)
  const chunks = chunkSegments(transcript.segments, targetSeconds, maxChars)
  const url = `https://www.bilibili.com/video/${transcript.bvid}`
  const total = chunks.length
  const llmChat = options.llmChat ?? chat

  progress(`并发总结 ${total} 段...`)
  const notes: string[] = new Array(total).fill('')

  // 并发 map；单块失败用带时间戳原文降级
  await Promise.all(
    chunks.map(async (chunk, i) => {
      const index = i + 1
      try {
        notes[i] = await mapChunk(config, settings, transcript.title, total, index, chunk, llmChat, options.onUsage)
      } catch (error) {
        progress(`第 ${index}/${total} 段总结失败，用原文降级：${(error as Error).message}`)
        notes[i] = chunk
          .map((segment) => `- [${formatTs(segment.start)}] ${segment.text}`)
          .join('\n')
      }
      progress(`第 ${index}/${total} 段完成`)
    })
  )

  const notesText = notes
    .map((note, index) => `#### 第 ${index + 1} 段\n${note}`)
    .join('\n\n')

  progress('合并分段要点并生成最终笔记')
  const reduceUser = REDUCE_USER
    .replace('{title}', transcript.title)
    .replace('{owner}', transcript.owner || '未知')
    .replace('{duration}', formatTs(transcript.duration))
    .replace('{url}', url)
    .replace('{notes}', notesText)
    .replace('{key_points_max_chars}', String(KEY_POINTS_MAX_CHARS))

  let markdown = await llmChat(
    config,
    [
      { role: 'system', content: REDUCE_SYSTEM },
      { role: 'user', content: reduceUser }
    ],
    { temperature: 0.2, timeout: 300, onUsage: options.onUsage }
  )

  markdown = stripCodeFence(markdown)
  markdown = await enforceKeyPointsLimit(markdown, config, progress, options.onUsage, llmChat)
  if (!markdown.trimStart().startsWith('#')) {
    markdown = `# ${transcript.title}\n\n${markdown}`
  }
  return markdown
}

/** 对齐 summarize._strip_code_fence */
export function stripCodeFence(text: string): string {
  let t = text.trim()
  if (t.startsWith('```')) {
    t = t.replace(/^\s*```(?:markdown|md)?\s*\n/, '')
    t = t.replace(/\n```\s*$/, '')
  }
  return t.trim()
}

/** 对齐 summarize._count_key_points_chars：去掉 Markdown 符号、列表编号和空白后按字符计 */
function countKeyPointsChars(body: string): number {
  let text = body.replace(/[*`]/g, '')
  text = text.replace(/^\s*\d+\.\s*/gm, '')
  return text.replace(/\s/g, '').length
}

/** 对齐 summarize._enforce_key_points_limit */
async function enforceKeyPointsLimit(
  markdown: string,
  config: AppConfig,
  progress: (message: string) => void,
  onUsage: ((usage: LlmUsage) => void) | undefined,
  llmChat: typeof chat
): Promise<string> {
  const match = KEY_POINTS_SECTION_RE.exec(markdown)
  if (!match || match.indices === undefined) return markdown

  const body = match[2].trim()
  const current = countKeyPointsChars(body)
  if (current <= KEY_POINTS_MAX_CHARS) return markdown

  progress(`核心要点 ${current} 字超出 ${KEY_POINTS_MAX_CHARS} 字上限，定向压缩中...`)
  let compressed: string
  try {
    compressed = await llmChat(
      config,
      [
        { role: 'system', content: MAP_SYSTEM },
        {
          role: 'user',
          content: COMPRESS_KEY_POINTS_USER
            .replace('{current}', String(current))
            .replace('{limit}', String(KEY_POINTS_MAX_CHARS))
            .replace('{body}', body)
        }
      ],
      { temperature: 0.2, onUsage }
    )
  } catch (error) {
    progress(`核心要点压缩失败，保留原文：${(error as Error).message}`)
    return markdown
  }

  compressed = stripCodeFence(compressed).trim()
  // 只在确实缩短时替换，避免无效结果覆盖原文
  if (countKeyPointsChars(compressed) < current) {
    const group2 = match.indices?.[2]
    if (group2) {
      const [start, end] = group2
      return markdown.slice(0, start) + compressed + '\n' + markdown.slice(end)
    }
  }
  progress('压缩后仍未明显缩短，保留原文')
  return markdown
}

export type { ChatMessage }
