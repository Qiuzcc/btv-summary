/**
 * 主进程与渲染层共享的领域类型。
 * 字段与 archive/btv/models.py 的 dataclass 一一对应。
 */

export interface Segment {
  start: number
  end: number
  text: string
}

export type TranscriptSource = 'subtitle' | 'asr' | 'unknown' | string

export interface Transcript {
  bvid: string
  title: string
  owner: string
  duration: number
  source: TranscriptSource
  segments: Segment[]
}

/** 与 Python transcript.json 落盘结构一致的序列化形状 */
export interface TranscriptDTO {
  bvid: string
  title: string
  owner: string
  duration: number
  source: TranscriptSource
  segments: Array<{ start: number; end: number; text: string }>
}

export type TaskState =
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'done'
  | 'error'
  | 'cancelled'
  | 'interrupted'

export interface ProgressSnapshot {
  phase: string
  message: string
  done: number
  total: number
  updatedAt: string
}

export interface TaskRecord {
  id: string
  bvid: string
  title: string
  state: TaskState
  params: TaskParams
  outputPath: string | null
  progress: ProgressSnapshot | null
  error: string | null
  createdAt: string
  updatedAt: string
}

export interface TaskParams {
  url: string
  detail: 'brief' | 'normal' | 'deep'
  format: 'md' | 'json'
  refresh: boolean
  noSubtitle: boolean
  chunkSeconds: number | null
  model: string | null
  output: string | null
}

export interface AppConfig {
  bilibili: { sessdata: string }
  llm: {
    base_url: string
    api_key: string
    model: string
    temperature: number
    max_chars: number
    /** 单次总结允许的最大输入字符数，超出后退回分块 Map-Reduce */
    max_input_chars: number
    max_retries: number
  }
  asr: { language: string }
  cloud_asr: { base_url: string; api_key: string; model: string }
  concurrency: { videos: number; llm: number; asr: number }
}
