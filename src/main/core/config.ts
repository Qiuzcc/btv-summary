/**
 * 配置读写：默认值、深度合并、dotted-path 访问、密钥加密信封与打码展示。
 * 结构对齐 archive/btv/config.py 的 DEFAULTS，并扩展 concurrency。
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AppConfig } from '../../shared/types'
import type { SecretCodec } from './secret-codec'
import { isEnvelope } from './secret-codec'

export type { AppConfig }

export const SECRET_PATHS = [
  'bilibili.sessdata',
  'llm.api_key',
  'cloud_asr.api_key'
] as const

export const DEFAULT_CONFIG: AppConfig = {
  bilibili: { sessdata: '' },
  llm: {
    base_url: 'https://api.deepseek.com/v1',
    api_key: '',
    model: 'deepseek-chat',
    temperature: 0.3,
    max_chars: 6000,
    max_retries: 3
  },
  asr: { language: '' },
  cloud_asr: {
    base_url: '',
    api_key: '',
    model: 'XingChenAGI/XingChenASR-Diarize-V3.0'
  },
  concurrency: { videos: 2, llm: 5, asr: 1 }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 对齐 config._deep_merge */
export function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return (override === undefined ? base : (override as T)) ?? base
  }
  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    const current = merged[key]
    merged[key] = isPlainObject(current) && isPlainObject(value)
      ? deepMerge(current, value)
      : value
  }
  return merged as T
}

function walkPath(root: Record<string, unknown>, path: string): unknown {
  let current: unknown = root
  for (const part of path.split('.')) {
    if (!isPlainObject(current) || !(part in current)) return undefined
    current = current[part]
  }
  return current
}

function setNested(root: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  let current: Record<string, unknown> = root
  for (const part of parts.slice(0, -1)) {
    const node = current[part]
    if (!isPlainObject(node)) {
      current[part] = {}
    }
    current = current[part] as Record<string, unknown>
  }
  current[parts[parts.length - 1]] = value
}

/** 对齐 config.get */
export function getValue<T = unknown>(
  config: Record<string, unknown>,
  path: string,
  fallback?: T
): T | undefined {
  const value = walkPath(config, path)
  return value === undefined ? fallback : (value as T)
}

/** 对齐 config._coerce + set_value：字符串先尝试 JSON 解析，失败按原文 */
export function setValue(
  config: Record<string, unknown>,
  path: string,
  raw: string
): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = raw
  }
  setNested(config, path, parsed)
}

/** 对齐 cli._extract_sessdata：支持完整 Cookie 与裸 SESSDATA */
export function extractSessdata(raw: string): string {
  const trimmed = raw.trim()
  const marker = 'SESSDATA='
  const index = trimmed.indexOf(marker)
  if (index >= 0) {
    // 等价 Python split('SESSDATA=', 1)[1].split(';', 1)[0]
    return trimmed.slice(index + marker.length).split(';', 1)[0].trim()
  }
  return trimmed
}

/** 对齐 config.masked：密钥保留首4末4，过短仅显示 **** */
export function maskConfig(config: AppConfig): AppConfig {
  const safe = structuredClone(config) as unknown as Record<string, unknown>
  for (const path of SECRET_PATHS) {
    const value = walkPath(safe, path)
    if (typeof value === 'string' && value) {
      setNested(
        safe,
        path,
        value.length > 8 ? value.slice(0, 4) + '****' + value.slice(-4) : '****'
      )
    }
  }
  return safe as unknown as AppConfig
}

/** 读盘：文件缺失返回默认值；坏 JSON 报中文错误；密钥信封自动解密 */
export function loadConfig(configPath: string, codec: SecretCodec): AppConfig {
  let raw: string
  try {
    raw = readFileSync(configPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return structuredClone(DEFAULT_CONFIG)
    }
    throw error
  }
  let userConfig: Record<string, unknown>
  try {
    userConfig = JSON.parse(raw) as Record<string, unknown>
  } catch (error) {
    throw new Error(`配置文件不是合法 JSON：${configPath}`)
  }
  const merged = deepMerge(structuredClone(DEFAULT_CONFIG), userConfig) as unknown as Record<
    string,
    unknown
  >
  for (const path of SECRET_PATHS) {
    const value = walkPath(merged, path)
    if (isEnvelope(value)) {
      setNested(merged, path, codec.decrypt(value))
    } else if (typeof value === 'string' && value) {
      // 兼容迁移期落入的明文值：原样可读，下次保存时自动加密
      setNested(merged, path, value)
    }
  }
  return merged as unknown as AppConfig
}

/** 写盘：密钥字段加密为信封，文件权限 0600 */
export function saveConfig(
  config: AppConfig,
  configPath: string,
  codec: SecretCodec
): void {
  const payload = structuredClone(config) as unknown as Record<string, unknown>
  for (const path of SECRET_PATHS) {
    const value = walkPath(payload, path)
    if (typeof value === 'string' && value) {
      setNested(payload, path, codec.encrypt(value))
    }
  }
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 })
  writeFileSync(configPath, JSON.stringify(payload, null, 2) + '\n', 'utf8')
  chmodSync(configPath, 0o600)
}
