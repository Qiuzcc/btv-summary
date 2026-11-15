/**
 * 云端 ASR：multipart/form-data 上传音频，超时 900s。
 * 对齐 archive/btv/asr.py：segments 解析、仅 text 降级单段、空文本报错、按末段 end 回调秒数。
 */
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import type { AppConfig } from './config'
import type { Segment } from '../../shared/types'

export interface AsrUsageCallback {
  (model: string, seconds: number): void
}

export interface AsrOptions {
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}

function mimeFor(path: string): string {
  return extname(path).toLowerCase() === '.mp3' ? 'audio/mpeg' : 'audio/wav'
}

/** 对齐 asr.transcribe_cloud：缺 base_url/api_key 立即报错 */
export async function transcribeCloud(
  path: string,
  baseUrl: string,
  apiKey: string,
  model: string,
  language = '',
  options: AsrOptions = {}
): Promise<Segment[]> {
  if (!baseUrl || !apiKey) {
    throw new Error('云端转写需要配置 cloud_asr.base_url 与 cloud_asr.api_key')
  }
  const fetchImpl = options.fetchImpl ?? fetch
  const url = baseUrl.replace(/\/+$/, '') + '/audio/transcriptions'

  const form = new FormData()
  form.append('model', model)
  form.append('response_format', 'verbose_json')
  if (language) form.append('language', language)

  const mime = mimeFor(path)
  const fileName = path.split('/').pop() || 'audio'
  const buffer = readFileSync(path)
  form.append('file', new Blob([buffer], { type: mime }), fileName)

  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` }

  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: form,
      signal: options.signal ?? AbortSignal.timeout(900_000)
    })
  } catch (error) {
    throw new Error(`云端转写请求失败：${(error as Error).message}`)
  }

  if (response.status >= 400) {
    const text = await response.text().catch(() => '')
    throw new Error(`云端转写失败 ${response.status}：${text.slice(0, 300)}`)
  }

  let payload: any
  try {
    payload = await response.json()
  } catch {
    throw new Error('云端转写返回格式异常：响应不是合法 JSON')
  }

  const segments: Segment[] = []
  for (const item of payload?.segments || []) {
    const text = String(item?.text ?? '').trim()
    if (text) {
      segments.push({
        start: Number(item.start),
        end: Number(item.end),
        text
      })
    }
  }
  if (segments.length === 0 && payload?.text) {
    segments.push({ start: 0, end: 0, text: String(payload.text).trim() })
  }
  if (segments.length === 0) {
    throw new Error('云端转写没有返回文本')
  }
  return segments
}

/** 对齐 asr.transcribe：读取配置、调用云端、按末段 end 回调秒数 */
export async function transcribe(
  path: string,
  config: AppConfig,
  onUsage?: AsrUsageCallback,
  options: AsrOptions = {}
): Promise<Segment[]> {
  const language = config.asr.language || ''
  const cloud = config.cloud_asr
  const model = cloud.model || 'whisper-1'
  const segments = await transcribeCloud(
    path,
    cloud.base_url || '',
    cloud.api_key || '',
    model,
    language,
    options
  )
  if (onUsage && segments.length > 0) {
    onUsage(model, Number(segments[segments.length - 1].end))
  }
  return segments
}
