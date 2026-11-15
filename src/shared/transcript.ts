/**
 * 转写领域纯函数：时间戳、SRT、分块、目录名安全化、JSON 序列化。
 * 逐函数对齐 archive/btv/models.py 与 archive/btv/summarize.py、cli.py。
 */
import type { Segment, Transcript, TranscriptDTO } from './types'

const pad2 = (value: number): string => String(value).padStart(2, '0')
const pad3 = (value: number): string => String(value).padStart(3, '0')

/** 对齐 summarize.format_ts：小时位仅在 >0 时出现 */
export function formatTs(seconds: number): string {
  const total = Math.max(0, Math.trunc(seconds))
  const hours = Math.floor(total / 3600)
  const remainder = total % 3600
  const minutes = Math.floor(remainder / 60)
  const secs = remainder % 60
  if (hours) return `${pad2(hours)}:${pad2(minutes)}:${pad2(secs)}`
  return `${pad2(minutes)}:${pad2(secs)}`
}

/** 对齐 models._srt_time：HH:MM:SS,mmm */
export function srtTime(seconds: number): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000))
  const hours = Math.floor(totalMs / 3_600_000)
  const remainder = totalMs % 3_600_000
  const minutes = Math.floor(remainder / 60_000)
  const rest = remainder % 60_000
  const secs = Math.floor(rest / 1000)
  const millis = rest % 1000
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(secs)},${pad3(millis)}`
}

/** 对齐 Transcript.to_srt */
export function toSrt(segments: Segment[]): string {
  return segments
    .map(
      (segment, index) =>
        `${index + 1}\n${srtTime(segment.start)} --> ${srtTime(segment.end)}\n${segment.text}\n`
    )
    .join('\n')
}

/** 对齐 summarize.chunk_segments：秒数与字数双阈值切块 */
export function chunkSegments(
  segments: Segment[],
  chunkSeconds: number,
  maxChars: number
): Segment[][] {
  const chunks: Segment[][] = []
  let current: Segment[] = []
  let start: number | null = null
  let chars = 0
  let lastEnd = 0

  for (const segment of segments) {
    if (start === null) start = segment.start
    current.push(segment)
    chars += segment.text.length
    lastEnd = segment.end
    if (lastEnd - start >= chunkSeconds || chars >= maxChars) {
      chunks.push(current)
      current = []
      start = null
      chars = 0
    }
  }
  if (current.length) chunks.push(current)
  return chunks
}

/** 对齐 cli._safe_dirname：非法字符替换、空白折叠、去点、80 字截断、空值回退 */
export function safeDirname(name: string, fallback: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '')
  return (cleaned || fallback).slice(0, 80)
}

export function serializeTranscript(transcript: Transcript): TranscriptDTO {
  return {
    bvid: transcript.bvid,
    title: transcript.title,
    owner: transcript.owner,
    duration: transcript.duration,
    source: transcript.source,
    segments: transcript.segments.map((s) => ({
      start: s.start,
      end: s.end,
      text: s.text
    }))
  }
}

/** 对齐 Transcript.from_dict 的默认值与类型转换 */
export function parseTranscript(data: TranscriptDTO): Transcript {
  return {
    bvid: data.bvid,
    title: data.title || data.bvid,
    owner: data.owner || '',
    duration: Math.trunc(data.duration || 0),
    source: data.source || 'unknown',
    segments: (data.segments || []).map((item) => ({
      start: Number(item.start),
      end: Number(item.end),
      text: item.text
    }))
  }
}
