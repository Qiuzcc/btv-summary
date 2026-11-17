import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskManager } from '../src/main/core/task-manager'
import { DEFAULT_CONFIG, type AppConfig } from '../src/main/core/config'
import type { TaskParams } from '../src/shared/types'

// mock pipeline 避免真实网络；默认用 gate 控制何时完成，便于测试取消
let gate: Promise<void> | null = null
vi.mock('../src/main/core/pipeline', () => ({
  runPipeline: vi.fn(async (deps: any) => {
    deps.progress('meta', 'ok', 1, 1)
    if (gate) await gate
    return {
      transcript: { bvid: 'BV1TEST12345', title: '测试', owner: '', duration: 10, source: 'asr', segments: [] },
      markdown: '# 测试',
      outputPath: '/tmp/out.md',
      usageRecord: { ts: 'x', bvid: 'BV1TEST12345', title: '测试', llm: { items: [], unknown: [], cost: 0 }, asr: { items: [], unknown: [], cost: 0 }, total: 0 }
    }
  })
}))

let dir: string
beforeEach(() => {
  dir = join(tmpdir(), 'btv-tm-' + Math.random().toString(36).slice(2, 8))
  mkdirSync(dir, { recursive: true })
  process.env['BTV_USERDATA'] = dir
})
afterEach(() => {
  gate = null
  rmSync(dir, { recursive: true, force: true })
  delete process.env['BTV_USERDATA']
})

function baseParams(): TaskParams {
  return {
    url: 'BV1TEST12345',
    detail: 'normal',
    format: 'md',
    refresh: false,
    noSubtitle: false,
    chunkSeconds: null,
    model: null,
    output: null
  }
}

describe('TaskManager', () => {
  const config = structuredClone(DEFAULT_CONFIG) as AppConfig

  it('提交任务后入队并完成', async () => {
    gate = null
    const tm = new TaskManager({ config })
    const task = tm.submit(baseParams())
    expect(task.state).toBe('queued')
    await new Promise((r) => setTimeout(r, 50))
    const updated = tm.get(task.id)!
    expect(updated.state).toBe('done')
    expect(updated.outputPath).toBe('/tmp/out.md')
  })

  it('FR-20 同一 BV 重复提交被拒绝', () => {
    const tm = new TaskManager({ config })
    tm.submit(baseParams())
    expect(() => tm.submit(baseParams())).toThrow(/已有进行中的任务/)
  })

  it('FR-21 取消排队中任务', async () => {
    // gate 阻塞首个任务，使后续任务保持 queued
    let release: () => void = () => {}
    gate = new Promise((r) => { release = r })
    const tm = new TaskManager({ config })
    tm.submit(baseParams()) // t1 运行中，被 gate 阻塞
    await new Promise((r) => setTimeout(r, 20))
    const t2 = tm.submit({ ...baseParams(), url: 'BV1OTHER0001' })
    tm.cancel(t2.id)
    const state = tm.get(t2.id)!.state
    expect(['cancelled', 'cancelling']).toContain(state)
    release()
  })

  it('FR-22 重启后运行中任务标记为 interrupted 并可续跑', () => {
    // 预置 tasks.json 含 running 任务
    const tasksPath = join(dir, 'tasks.json')
    writeFileSync(
      tasksPath,
      JSON.stringify([
        {
          id: 'old-1',
          bvid: 'BV1TEST12345',
          title: 't',
          state: 'running',
          params: baseParams(),
          outputPath: null,
          progress: null,
          error: null,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z'
        }
      ])
    )
    const tm = new TaskManager({ config })
    expect(tm.get('old-1')!.state).toBe('interrupted')
    tm.resume('old-1')
    expect(tm.get('old-1')!.state).toBe('queued')
  })

  it('持久化 tasks.json 落盘', async () => {
    gate = null
    const tm = new TaskManager({ config })
    tm.submit(baseParams())
    await new Promise((r) => setTimeout(r, 50))
    expect(existsSync(join(dir, 'tasks.json'))).toBe(true)
  })

  it.each(['done', 'error', 'cancelled', 'interrupted'] as const)(
    '允许删除 %s 状态任务并持久化移除',
    (state) => {
      const tasksPath = join(dir, 'tasks.json')
      writeFileSync(
        tasksPath,
        JSON.stringify([
          {
            id: 'task-1',
            bvid: 'BV1TEST12345',
            title: 't',
            state,
            params: baseParams(),
            outputPath: '/tmp/out.md',
            progress: null,
            error: null,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z'
          }
        ])
      )
      const onEvent = vi.fn()
      const tm = new TaskManager({ config, onEvent })

      tm.remove('task-1')

      expect(tm.get('task-1')).toBeUndefined()
      expect(tm.list()).toEqual([])
      expect(JSON.parse(readFileSync(tasksPath, 'utf8'))).toEqual([])
      expect(onEvent).toHaveBeenCalledWith({ type: 'removed', taskId: 'task-1' })
      expect(new TaskManager({ config }).list()).toEqual([])
    }
  )

  it('拒绝删除 queued、running、cancelling 状态任务', async () => {
    let release: () => void = () => {}
    gate = new Promise((r) => { release = r })
    const onEvent = vi.fn()
    const tm = new TaskManager({ config, onEvent })
    const task = tm.submit(baseParams())

    expect(task.state).toBe('queued')
    expect(() => tm.remove(task.id)).toThrow(/仅允许删除/)
    await new Promise((r) => setTimeout(r, 20))
    expect(tm.get(task.id)!.state).toBe('running')
    expect(() => tm.remove(task.id)).toThrow(/仅允许删除/)
    tm.cancel(task.id)
    expect(tm.get(task.id)!.state).toBe('cancelling')
    expect(() => tm.remove(task.id)).toThrow(/仅允许删除/)

    expect(tm.get(task.id)).toBeDefined()
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'removed' }))
    release()
    await new Promise((r) => setTimeout(r, 50))
  })

  it('删除任务不影响输出、缓存和用量文件', () => {
    const outputPath = join(dir, 'output', 'summary.md')
    const transcriptPath = join(dir, 'cache', 'BV1TEST12345', 'transcript.json')
    const usagePath = join(dir, 'cache', 'usage.jsonl')
    mkdirSync(join(dir, 'output'), { recursive: true })
    mkdirSync(join(dir, 'cache', 'BV1TEST12345'), { recursive: true })
    writeFileSync(outputPath, '# summary')
    writeFileSync(transcriptPath, '{"segments":[]}')
    writeFileSync(usagePath, '{"total":1}\n')
    writeFileSync(
      join(dir, 'tasks.json'),
      JSON.stringify([
        {
          id: 'task-1',
          bvid: 'BV1TEST12345',
          title: 't',
          state: 'done',
          params: baseParams(),
          outputPath,
          progress: null,
          error: null,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z'
        }
      ])
    )
    const tm = new TaskManager({ config })

    tm.remove('task-1')

    expect(readFileSync(outputPath, 'utf8')).toBe('# summary')
    expect(readFileSync(transcriptPath, 'utf8')).toBe('{"segments":[]}')
    expect(readFileSync(usagePath, 'utf8')).toBe('{"total":1}\n')
  })
})
