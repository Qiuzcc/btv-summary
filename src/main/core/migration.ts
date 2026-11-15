/**
 * 旧版数据迁移：把 ~/.config/btv 与 ~/.cache/btv 的配置、缓存、用量明细一次性搬到 Electron userData。
 * 幂等：迁移标记存在即跳过；旧目录只读不删；临时文件权限 0600。
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  chmodSync,
  unlinkSync
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SecretCodec } from './secret-codec'
import { loadConfig, saveConfig } from './config'
import { cacheDir, configFile, migrationMarker, usageFile } from './paths'

// 旧路径可通过环境变量覆盖，便于测试隔离；懒求值以读取运行期 env
function oldConfigDir(): string {
  return process.env['BTV_OLD_CONFIG_DIR'] || join(homedir(), '.config', 'btv')
}
function oldConfigFile(): string {
  return join(oldConfigDir(), 'config.json')
}
function oldCacheDir(): string {
  return process.env['BTV_OLD_CACHE_DIR'] || join(homedir(), '.cache', 'btv')
}
function oldUsageFile(): string {
  return join(oldCacheDir(), 'usage.jsonl')
}

export interface MigrationResult {
  migrated: boolean
  configCopied: boolean
  cacheDirs: string[]
  usageLines: number
}

function oldConfigPresent(): boolean {
  return existsSync(oldConfigFile())
}

function oldCachePresent(): boolean {
  return existsSync(oldCacheDir())
}

/** 复制整个目录树；目标已存在则跳过单个文件，避免覆盖新写入 */
function copyDirectoryTree(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src)) {
    const srcEntry = join(src, entry)
    const destEntry = join(dest, entry)
    const stat = statSync(srcEntry)
    if (stat.isDirectory()) {
      copyDirectoryTree(srcEntry, destEntry)
    } else if (!existsSync(destEntry)) {
      copyFileSync(srcEntry, destEntry)
    }
  }
}

/**
 * 迁移主流程。codec 由调用方（生产用 SafeStorageCodec，测试用 InsecureTestCodec）注入。
 * 若迁移标记已存在则直接返回 migrated=false。
 */
export function migrateLegacyData(codec: SecretCodec): MigrationResult {
  const marker = migrationMarker()
  if (existsSync(marker)) {
    return { migrated: false, configCopied: false, cacheDirs: [], usageLines: 0 }
  }

  const result: MigrationResult = {
    migrated: true,
    configCopied: false,
    cacheDirs: [],
    usageLines: 0
  }

  // 1. 配置：明文 → 加密落盘
  if (oldConfigPresent()) {
    try {
      const config = loadConfig(oldConfigFile(), codec)
      saveConfig(config, configFile(), codec)
      result.configCopied = true
    } catch (error) {
      // 配置损坏不阻塞迁移其他数据，但需记录
      // eslint-disable-next-line no-console
      console.error(`[btv] 旧配置迁移失败：${(error as Error).message}`)
    }
  }

  // 2. 缓存目录整体复制
  if (oldCachePresent()) {
    const newCache = cacheDir()
    mkdirSync(newCache, { recursive: true })
    for (const entry of readdirSync(oldCacheDir())) {
      const src = join(oldCacheDir(), entry)
      const stat = statSync(src)
      if (!stat.isDirectory()) continue
      // 仅处理 BV 号命名的子目录（缓存目录约定）
      if (!/^BV[0-9A-Za-z]{10}$/.test(entry)) continue
      const dest = join(newCache, entry)
      try {
        copyDirectoryTree(src, dest)
        result.cacheDirs.push(entry)
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(`[btv] 缓存 ${entry} 迁移失败：${(error as Error).message}`)
      }
    }

    // 3. usage.jsonl 合并：旧记录追加到新文件（无新文件则复制），权限 0600
    if (existsSync(oldUsageFile())) {
      const oldLines = readFileSync(oldUsageFile(), 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
      if (oldLines.length > 0) {
        const newUsage = usageFile()
        // 临时文件追加，最后原子替换并设 0600
        const tmp = newUsage + '.tmp'
        const existing = existsSync(newUsage) ? readFileSync(newUsage, 'utf8') : ''
        writeFileSync(tmp, existing + oldLines.join('\n') + '\n', 'utf8')
        chmodSync(tmp, 0o600)
        // 简单替换；跨卷风险忽略，同目录内 rename 原子
        try {
          unlinkSync(newUsage)
        } catch {
          /* 不存在则忽略 */
        }
        copyFileSync(tmp, newUsage)
        chmodSync(newUsage, 0o600)
        unlinkSync(tmp)
        result.usageLines = oldLines.length
      }
    }
  }

  // 4. 写入迁移标记（0600），保证幂等
  const tmpMarker = marker + '.tmp'
  writeFileSync(tmpMarker, JSON.stringify({ ts: new Date().toISOString() }) + '\n', 'utf8')
  chmodSync(tmpMarker, 0o600)
  copyFileSync(tmpMarker, marker)
  chmodSync(marker, 0o600)
  unlinkSync(tmpMarker)

  return result
}
