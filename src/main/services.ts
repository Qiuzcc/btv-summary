/**
 * 主进程服务层：配置、迁移、任务管理器、IPC 通道注册。
 * 由 index.ts 在 app.whenReady 后调用 bootstrap()。
 */
import { BrowserWindow, ipcMain, shell } from 'electron'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_CONFIG,
  extractSessdata,
  getValue,
  loadConfig,
  maskConfig,
  saveConfig,
  setValue,
  type AppConfig
} from './core/config'
import { SafeStorageCodec } from './core/safe-storage-codec'
import { migrateLegacyData } from './core/migration'
import { configFile, outputBaseDir } from './core/paths'
import { aggregate, loadRecords, resetRecords } from './core/usage'
import { TaskManager } from './core/task-manager'
import type { HistoryItem, TaskEvent } from '../shared/api-contract'
import type { TaskParams } from '../shared/types'

interface Services {
  config: AppConfig
  taskManager: TaskManager
  shutdown: () => void
}

function sendTaskEvent(win: BrowserWindow | null, event: TaskEvent): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send('task:event', event)
  }
}

export function bootstrap(getWindow: () => BrowserWindow | null): Services {
  const codec = new SafeStorageCodec()
  const config = loadConfig(configFile(), codec)

  // 首次启动迁移旧版数据
  try {
    migrateLegacyData(codec)
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[btv] 数据迁移失败：', error)
  }

  const taskManager = new TaskManager({
    config,
    onEvent: ({ type, taskId, payload }) => {
      if (type === 'state') {
        sendTaskEvent(getWindow(), { type: 'state', taskId, task: payload as any })
      } else if (type === 'progress') {
        sendTaskEvent(getWindow(), { type: 'progress', taskId, progress: payload as any })
      }
    }
  })

  // ---- 配置 ----
  ipcMain.handle('config:get', () => config)
  ipcMain.handle('config:masked', () => maskConfig(config))
  ipcMain.handle('config:set', (_e, key: string, value: string) => {
    // 密钥字段：SESSDATA 支持完整 Cookie 解析
    const cfg = config as unknown as Record<string, unknown>
    if (key === 'bilibili.sessdata') {
      setValue(cfg, key, extractSessdata(value))
    } else {
      setValue(cfg, key, value)
    }
    // 并发配额变更即时生效
    if (key.startsWith('concurrency.')) {
      const c = config.concurrency
      taskManager.setConcurrency(c.videos, c.llm, c.asr)
    }
    saveConfig(config, configFile(), codec)
  })

  // ---- 任务 ----
  ipcMain.handle('task:submit', (_e, params: TaskParams) => taskManager.submit(params))
  ipcMain.handle('task:list', () => taskManager.list())
  ipcMain.handle('task:cancel', (_e, taskId: string) => taskManager.cancel(taskId))
  ipcMain.handle('task:resume', (_e, taskId: string) => taskManager.resume(taskId))

  // ---- 成本 ----
  ipcMain.handle('usage:aggregate', () => aggregate(loadRecords()))
  ipcMain.handle('usage:reset', () => resetRecords())

  // ---- 输出 ----
  ipcMain.handle('output:open', (_e, path: string) => shell.openPath(path))
  ipcMain.handle('output:readMarkdown', (_e, path: string) => {
    if (!existsSync(path)) return ''
    return readFileSync(path, 'utf8')
  })
  ipcMain.handle('output:listHistory', () => listHistory())

  return {
    config,
    taskManager,
    shutdown: () => taskManager.shutdown()
  }
}

/** 列出 out/ 下的历史输出目录 */
function listHistory(): HistoryItem[] {
  const outDir = outputBaseDir()
  if (!existsSync(outDir)) return []
  const items: HistoryItem[] = []
  for (const entry of readdirSync(outDir)) {
    const dir = join(outDir, entry)
    const stat = statSync(dir)
    if (!stat.isDirectory()) continue
    const summaryPath = join(dir, 'summary.md')
    const jsonPath = join(dir, 'summary.json')
    const hasMd = existsSync(summaryPath)
    const hasJson = existsSync(jsonPath)
    if (!hasMd && !hasJson) continue
    // 从 transcript.json 或目录名推断 bvid/title
    let bvid = entry
    let title = entry
    const transcriptPath = join(dir, 'transcript.json')
    if (existsSync(transcriptPath)) {
      try {
        const data = JSON.parse(readFileSync(transcriptPath, 'utf8'))
        bvid = data.bvid || bvid
        title = data.title || title
      } catch {
        /* ignore */
      }
    }
    items.push({
      bvid,
      title,
      dir,
      summaryPath: hasMd ? summaryPath : hasJson ? jsonPath : null,
      updatedAt: stat.mtimeMs
    })
  }
  return items.sort((a, b) => b.updatedAt - a.updatedAt)
}

export { DEFAULT_CONFIG, getValue }
