/**
 * 总结引擎：map-reduce + 核心要点字数硬上限定向压缩。
 * 提示词常量与 archive/btv/summarize.py 逐字一致；流程、降级、后处理对齐。
 */
import type { AppConfig } from './config'
import { chat, type ChatMessage } from './llm'
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

export const SINGLE_PASS_SYSTEM =
  '你是资深内容编辑，负责把视频转写整理成一篇可读的视频摘要。' +
  '只使用转写中的信息，不要编造，不要输出与转写无关的评价。'

const VIDEO_INFO = `视频信息：
- 标题：{title}
- UP 主：{owner}
- 时长：{duration}
- 链接：{url}
`

const NOTE_STRUCTURE = `请输出一篇中文 Markdown 笔记，严格使用以下结构，不要用代码块包裹：

# {title}

> 来源：{url} · 时长 {duration} · UP 主 {owner}

## TL;DR
用 2 到 3 句话概括视频的核心结论。

## 核心要点
固定 5 条，按重要性排序，每条只讲一个要点；整个章节总字数严格控制在 {key_points_max_chars} 字以内（平均每条不超过 100 字），用短句直给结论，删掉修饰语、重复举例和括号补充。

## 值得追问
- 2 到 3 个视频没有回答、但值得继续查的问题。
`

export const REDUCE_USER = `${VIDEO_INFO}
下面是按时间顺序整理的分段要点：
{notes}

${NOTE_STRUCTURE}`

export const SINGLE_PASS_USER = `${VIDEO_INFO}
下面是视频的完整转写（带时间戳）：
{body}

${NOTE_STRUCTURE}`

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
  /** 注入 LLM 调用，便于单测；默认使用 llm.chat */
  llmChat?: typeof chat
}

/** 带时间戳的转写正文，Map 与单次总结共用 */
function formatBody(segments: Segment[]): string {
  return segments.map((segment) => `[${formatTs(segment.start)}] ${segment.text}`).join('\n')
}

/** 填充视频信息与笔记结构；payload 用函数替换，避免正文中的 $ 符号被当作替换模式 */
function fillNoteTemplate(
  template: string,
  transcript: Transcript,
  url: string,
  key: '{notes}' | '{body}',
  payload: string
): string {
  return template
    .replaceAll('{title}', transcript.title)
    .replaceAll('{owner}', transcript.owner || '未知')
    .replaceAll('{duration}', formatTs(transcript.duration))
    .replaceAll('{url}', url)
    .replace(key, () => payload)
    .replaceAll('{key_points_max_chars}', String(KEY_POINTS_MAX_CHARS))
}

async function mapChunk(
  config: AppConfig,
  settings: { chunk_seconds: number; min_bullets: number; max_bullets: number },
  title: string,
  total: number,
  index: number,
  chunk: Segment[],
  llmChat: typeof chat
): Promise<string> {
  const body = formatBody(chunk)
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
          .replace('{body}', () => body)
      }
    ]
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
  const maxInputChars = Math.trunc(config.llm.max_input_chars || 0)
  const url = `https://www.bilibili.com/video/${transcript.bvid}`
  const llmChat = options.llmChat ?? chat
  const body = formatBody(transcript.segments)

  let markdown: string
  if (!options.chunkSeconds && maxInputChars > 0 && body.length <= maxInputChars) {
    // 全文放得进模型上下文：单次总结，避免分块笔记二次压缩丢细节
    progress(`全文 ${body.length} 字，单次总结`)
    markdown = await llmChat(
      config,
      [
        { role: 'system', content: SINGLE_PASS_SYSTEM },
        {
          role: 'user',
          content: fillNoteTemplate(SINGLE_PASS_USER, transcript, url, '{body}', body)
        }
      ],
      { temperature: 0.2, timeout: 600 }
    )
  } else {
    const chunks = chunkSegments(transcript.segments, targetSeconds, maxChars)
    const total = chunks.length
    progress(`并发总结 ${total} 段...`)
    const notes: string[] = new Array(total).fill('')

    // 并发 map；单块失败用带时间戳原文降级
    await Promise.all(
      chunks.map(async (chunk, i) => {
        const index = i + 1
        try {
          notes[i] = await mapChunk(config, settings, transcript.title, total, index, chunk, llmChat)
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
    markdown = await llmChat(
      config,
      [
        { role: 'system', content: REDUCE_SYSTEM },
        {
          role: 'user',
          content: fillNoteTemplate(REDUCE_USER, transcript, url, '{notes}', notesText)
        }
      ],
      { temperature: 0.2, timeout: 300 }
    )
  }

  markdown = stripCodeFence(markdown)
  markdown = await enforceKeyPointsLimit(markdown, config, progress, llmChat)
  if (!markdown.trimStart().startsWith('#')) {
    markdown = `# ${transcript.title}\n\n${markdown}`
  }
  const originalTitle = transcript.source === 'subtitle' ? '原始字幕' : '原始转写'
  const originalText = transcript.segments.map((segment) => segment.text).join('\n')
  return `${markdown.trimEnd()}\n\n## ${originalTitle}\n\n${originalText}`
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
      { temperature: 0.2 }
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
