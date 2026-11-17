/**
 * 应用路径集中管理。运行期基于 Electron userData；
 * 测试可通过 BTV_USERDATA 环境变量重定向到临时目录。
 * electron 惰性加载，避免纯 Node 测试链路在 import 阶段崩溃。
 */
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

const nodeRequire = createRequire(import.meta.url)

function electronApp() {
  // BTV_USERDATA 命中时不触发 electron 加载，便于单测
  if (process.env['BTV_USERDATA']) return null
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return nodeRequire('electron').app
}

export function userDataDir(): string {
  if (process.env['BTV_USERDATA']) return process.env['BTV_USERDATA']
  return electronApp()!.getPath('userData')
}

export function configFile(): string {
  return join(userDataDir(), 'config.json')
}

export function cacheDir(): string {
  return join(userDataDir(), 'cache')
}

export function bvCacheDir(bvid: string): string {
  return join(cacheDir(), bvid)
}

export function tasksFile(): string {
  return join(userDataDir(), 'tasks.json')
}

export function migrationMarker(): string {
  return join(userDataDir(), 'migration-v1.done')
}

/**
 * 随包资源目录（yt-dlp/ffmpeg）。
 * - 打包后：process.resourcesPath 指向 .../Resources（app.asar 与 extraResources 同级）
 * - 开发态：process.resourcesPath 指向 Electron 自身的 Resources，必须改用项目根 resources
 */
export function resourcesDir(): string {
  const app = electronApp()
  if (!app) return join(process.cwd(), 'resources')
  if (app.isPackaged) return process.resourcesPath
  return join(app.getAppPath(), 'resources')
}

/** 输出根目录：默认放在用户目录下的 btv-summary，便于在 Finder 中找到 */
export function outputBaseDir(): string {
  return process.env['BTV_OUTPUT_DIR'] || join(homedir(), 'btv-summary')
}
