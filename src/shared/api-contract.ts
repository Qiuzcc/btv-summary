/**
 * preload 暴露给渲染层的 API 契约。
 * 主进程实现、preload 转发、渲染层消费，三处共用此类型。
 */
import type { AppConfig, ProgressSnapshot, TaskParams, TaskRecord, UsageAggregate } from './types'

export type TaskEvent =
  | { type: 'state'; taskId: string; task: TaskRecord }
  | { type: 'progress'; taskId: string; progress: ProgressSnapshot }

export interface HistoryItem {
  bvid: string
  title: string
  dir: string
  summaryPath: string | null
  updatedAt: number
}

export interface BtvApi {
  app: {
    version: () => Promise<string>
  }
  config: {
    get: () => Promise<AppConfig>
    set: (key: string, value: string) => Promise<void>
    masked: () => Promise<AppConfig>
  }
  task: {
    submit: (params: TaskParams) => Promise<TaskRecord>
    list: () => Promise<TaskRecord[]>
    cancel: (taskId: string) => Promise<void>
    resume: (taskId: string) => Promise<void>
    onEvent: (listener: (event: TaskEvent) => void) => () => void
  }
  usage: {
    aggregate: () => Promise<UsageAggregate>
    reset: () => Promise<void>
  }
  output: {
    open: (path: string) => Promise<void>
    readMarkdown: (path: string) => Promise<string>
    listHistory: () => Promise<HistoryItem[]>
  }
}
