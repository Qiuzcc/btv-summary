/**
 * 任务管理器：队列、三级限流、取消、持久化与续跑。
 * 视频并发由 videoSemaphore 控制；LLM/ASR 限流由 pipeline 内部信号量控制。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { AppConfig } from './config'
import { Semaphore } from './semaphore'
import { runPipeline, type PipelineDeps } from './pipeline'
import { tasksFile } from './paths'
import type { TaskParams, TaskRecord } from '../../shared/types'

interface TaskRuntime {
  controller: AbortController
  registry: ChildProcessRegistry
}

class ChildProcessRegistry {
  private children = new Set<ChildProcessWithoutNullStreams>()
  register(child: ChildProcessWithoutNullStreams): void {
    this.children.add(child)
    child.once('exit', () => this.children.delete(child))
  }
  killAll(): void {
    for (const child of this.children) {
      try {
        child.kill('SIGTERM')
      } catch {
        /* ignore */
      }
    }
    this.children.clear()
  }
}

export interface TaskManagerOptions {
  config: AppConfig
  onEvent?: (event: { type: 'progress' | 'state' | 'removed'; taskId: string; payload?: unknown }) => void
  fetchImpl?: typeof fetch
}

export class TaskManager {
  private tasks = new Map<string, TaskRecord>()
  private runtimes = new Map<string, TaskRuntime>()
  private readonly videoSemaphore: Semaphore
  private readonly llmSemaphore: Semaphore
  private readonly asrSemaphore: Semaphore
  private readonly config: AppConfig
  private readonly onEvent?: TaskManagerOptions['onEvent']
  private readonly fetchImpl?: typeof fetch
  private dispatching = false

  constructor(options: TaskManagerOptions) {
    this.config = options.config
    this.onEvent = options.onEvent
    this.fetchImpl = options.fetchImpl
    const c = options.config.concurrency
    this.videoSemaphore = new Semaphore(c.videos)
    this.llmSemaphore = new Semaphore(c.llm)
    this.asrSemaphore = new Semaphore(c.asr)
    this.load()
  }

  list(): TaskRecord[] {
    return [...this.tasks.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  get(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId)
  }

  private persist(): void {
    writeFileSync(tasksFile(), JSON.stringify(this.list(), null, 2), 'utf8')
  }

  private load(): void {
    const path = tasksFile()
    if (!existsSync(path)) return
    try {
      const records = JSON.parse(readFileSync(path, 'utf8')) as TaskRecord[]
      for (const record of records) {
        // 重启后运行中任务标记为已中断
        if (record.state === 'running' || record.state === 'cancelling') {
          record.state = 'interrupted'
          record.error = record.error || '应用重启，任务已中断'
        }
        this.tasks.set(record.id, record)
      }
    } catch {
      // 损坏文件忽略
    }
  }

  /** 同一 BV 号存在排队/运行中任务时拒绝重复提交 */
  submit(params: TaskParams): TaskRecord {
    const duplicate = [...this.tasks.values()].find(
      (t) =>
        t.bvid === params.url &&
        (t.state === 'queued' || t.state === 'running')
    )
    if (duplicate) {
      throw new Error(`该视频已有进行中的任务（${duplicate.id}），请勿重复提交`)
    }
    const now = new Date().toISOString()
    const task: TaskRecord = {
      id: randomUUID(),
      bvid: params.url,
      title: params.url,
      state: 'queued',
      params,
      outputPath: null,
      progress: null,
      error: null,
      createdAt: now,
      updatedAt: now
    }
    this.tasks.set(task.id, task)
    this.persist()
    void this.dispatch()
    return task
  }

  private async dispatch(): Promise<void> {
    if (this.dispatching) return
    this.dispatching = true
    try {
      // 持续调度直到没有可运行任务
      while (true) {
        const queued = this.list().filter((t) => t.state === 'queued')
        if (queued.length === 0) break
        if (this.videoSemaphore.inUse >= this.videoSemaphore.capacity) break
        const task = queued[queued.length - 1]
        await this.start(task.id)
      }
    } finally {
      this.dispatching = false
    }
  }

  private async start(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId)
    if (!task || task.state !== 'queued') return

    await this.videoSemaphore.acquire()
    const controller = new AbortController()
    const registry = new ChildProcessRegistry()
    this.runtimes.set(taskId, { controller, registry })

    task.state = 'running'
    task.updatedAt = new Date().toISOString()
    this.persist()
    this.emitState(task)

    const progress: PipelineDeps['progress'] = (phase, message, done, total) => {
      task.progress = { phase, message, done, total, updatedAt: new Date().toISOString() }
      task.updatedAt = task.progress.updatedAt
      this.emitProgress(task)
    }

    try {
      const result = await runPipeline({
        config: this.config,
        params: task.params,
        llmSemaphore: this.llmSemaphore,
        asrSemaphore: this.asrSemaphore,
        registry,
        signal: controller.signal,
        progress,
        fetchImpl: this.fetchImpl
      })
      task.title = result.transcript.title
      task.outputPath = result.outputPath
      task.state = 'done'
      task.progress = { phase: 'done', message: `完成，输出 ${result.outputPath}`, done: 1, total: 1, updatedAt: new Date().toISOString() }
      task.updatedAt = new Date().toISOString()
      this.persist()
      this.emitState(task)
    } catch (error) {
      if (controller.signal.aborted) {
        task.state = 'cancelled'
        task.error = '已取消'
      } else {
        task.state = 'error'
        task.error = (error as Error).message
      }
      task.updatedAt = new Date().toISOString()
      this.persist()
      this.emitState(task)
    } finally {
      this.videoSemaphore.release()
      this.runtimes.delete(taskId)
      void this.dispatch()
    }
  }

  cancel(taskId: string): void {
    const task = this.tasks.get(taskId)
    if (!task) return
    if (task.state !== 'queued' && task.state !== 'running') return
    const runtime = this.runtimes.get(taskId)
    if (runtime) {
      task.state = 'cancelling'
      this.persist()
      this.emitState(task)
      runtime.registry.killAll()
      runtime.controller.abort()
    } else {
      // 排队中直接取消
      task.state = 'cancelled'
      task.error = '已取消'
      task.updatedAt = new Date().toISOString()
      this.persist()
      this.emitState(task)
    }
  }

  cancelAll(): void {
    for (const task of this.list()) {
      if (task.state === 'queued' || task.state === 'running') {
        this.cancel(task.id)
      }
    }
  }

  remove(taskId: string): void {
    const task = this.tasks.get(taskId)
    if (!task) return
    if (task.state !== 'done' && task.state !== 'error' && task.state !== 'cancelled' && task.state !== 'interrupted') {
      throw new Error('仅允许删除已完成、失败、已取消或已中断的任务')
    }
    this.tasks.delete(taskId)
    this.persist()
    this.onEvent?.({ type: 'removed', taskId })
  }

  /** 续跑已中断任务：重新入队 */
  resume(taskId: string): void {
    const task = this.tasks.get(taskId)
    if (!task) return
    if (task.state !== 'interrupted' && task.state !== 'error' && task.state !== 'cancelled') return
    task.state = 'queued'
    task.error = null
    task.progress = null
    task.updatedAt = new Date().toISOString()
    this.persist()
    this.emitState(task)
    void this.dispatch()
  }

  private emitState(task: TaskRecord): void {
    this.onEvent?.({ type: 'state', taskId: task.id, payload: task })
  }

  private emitProgress(task: TaskRecord): void {
    this.onEvent?.({ type: 'progress', taskId: task.id, payload: task.progress })
  }

  /** 应用退出时统一回收 */
  shutdown(): void {
    this.cancelAll()
  }

  /** 运行期调整三级并发配额 */
  setConcurrency(videos: number, llm: number, asr: number): void {
    this.videoSemaphore.setMax(videos)
    this.llmSemaphore.setMax(llm)
    this.asrSemaphore.setMax(asr)
  }
}
