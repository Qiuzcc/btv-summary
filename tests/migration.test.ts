import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrateLegacyData } from '../src/main/core/migration'
import { InsecureTestCodec } from '../src/main/core/secret-codec'
import { loadConfig } from '../src/main/core/config'

function tmpDir(prefix: string): string {
  const dir = join(tmpdir(), prefix + '-' + Math.random().toString(36).slice(2, 8))
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('迁移模块', () => {
  let oldHome: string
  let newHome: string
  const codec = new InsecureTestCodec()

  beforeEach(() => {
    oldHome = tmpDir('btv-old')
    newHome = tmpDir('btv-new')
    process.env['BTV_OLD_CONFIG_DIR'] = join(oldHome, '.config', 'btv')
    process.env['BTV_OLD_CACHE_DIR'] = join(oldHome, '.cache', 'btv')
    process.env['BTV_USERDATA'] = newHome
    mkdirSync(process.env['BTV_OLD_CONFIG_DIR']!, { recursive: true })
    mkdirSync(process.env['BTV_OLD_CACHE_DIR']!, { recursive: true })
  })

  afterEach(() => {
    rmSync(oldHome, { recursive: true, force: true })
    rmSync(newHome, { recursive: true, force: true })
    delete process.env['BTV_OLD_CONFIG_DIR']
    delete process.env['BTV_OLD_CACHE_DIR']
    delete process.env['BTV_USERDATA']
  })

  it('TR-3.1 明文配置加密写入、缓存复制、usage 合并', () => {
    // 旧明文配置（含密钥）
    const oldConfig = {
      bilibili: { sessdata: 'old-sessdata-secret' },
      llm: { base_url: 'https://api.deepseek.com/v1', api_key: 'sk-oldkey', model: 'deepseek-chat' },
      asr: { language: '' },
      cloud_asr: { base_url: '', api_key: 'cloud-old', model: 'XingChenAGI/XingChenASR-Diarize-V3.0' }
    }
    writeFileSync(join(process.env['BTV_OLD_CONFIG_DIR']!, 'config.json'), JSON.stringify(oldConfig))

    // 旧缓存目录
    const bv = 'BV1TEST12345'
    const oldBvCache = join(process.env['BTV_OLD_CACHE_DIR']!, bv)
    mkdirSync(oldBvCache, { recursive: true })
    writeFileSync(join(oldBvCache, 'transcript.json'), JSON.stringify({ bvid: bv, segments: [] }))
    writeFileSync(join(oldBvCache, 'audio.mp3'), Buffer.from('fake-mp3'))

    // 旧 usage
    const usageLine = JSON.stringify({ ts: '2026-01-01T00:00:00', bvid: bv, title: 't', total: 0.01 })
    writeFileSync(join(process.env['BTV_OLD_CACHE_DIR']!, 'usage.jsonl'), usageLine + '\n')

    const result = migrateLegacyData(codec)
    expect(result.migrated).toBe(true)
    expect(result.configCopied).toBe(true)
    expect(result.cacheDirs).toContain(bv)
    expect(result.usageLines).toBe(1)

    // 新配置：密文落盘 + 可读
    const newCfgPath = join(newHome, 'config.json')
    const onDisk = readFileSync(newCfgPath, 'utf8')
    expect(onDisk).not.toContain('old-sessdata-secret')
    expect(onDisk).not.toContain('sk-oldkey')
    expect(onDisk).toContain('enc:v1:')
    expect(statSync(newCfgPath).mode & 0o777).toBe(0o600)
    const loaded = loadConfig(newCfgPath, codec)
    expect(loaded.bilibili.sessdata).toBe('old-sessdata-secret')
    expect(loaded.llm.api_key).toBe('sk-oldkey')

    // 缓存文件齐全且可命中
    expect(existsSync(join(newHome, 'cache', bv, 'transcript.json'))).toBe(true)
    expect(existsSync(join(newHome, 'cache', bv, 'audio.mp3'))).toBe(true)

    // usage 合并
    const usagePath = join(newHome, 'cache', 'usage.jsonl')
    expect(existsSync(usagePath)).toBe(true)
    expect(statSync(usagePath).mode & 0o777).toBe(0o600)
    expect(readFileSync(usagePath, 'utf8').trim()).toBe(usageLine)
  })

  it('TR-3.2 二次执行幂等，不产生重复数据', () => {
    const oldConfig = { bilibili: { sessdata: 'x' } }
    writeFileSync(join(process.env['BTV_OLD_CONFIG_DIR']!, 'config.json'), JSON.stringify(oldConfig))
    const usageLine = JSON.stringify({ ts: '2026-01-01T00:00:00', bvid: 'BV1TEST12345', total: 0.01 })
    writeFileSync(join(process.env['BTV_OLD_CACHE_DIR']!, 'usage.jsonl'), usageLine + '\n')

    const first = migrateLegacyData(codec)
    expect(first.migrated).toBe(true)
    expect(first.usageLines).toBe(1)

    const second = migrateLegacyData(codec)
    expect(second.migrated).toBe(false)
    expect(second.usageLines).toBe(0)

    const usagePath = join(newHome, 'cache', 'usage.jsonl')
    const lines = readFileSync(usagePath, 'utf8').split('\n').filter((l) => l.trim())
    expect(lines).toHaveLength(1)

    // 旧目录保持原样
    expect(readFileSync(join(process.env['BTV_OLD_CONFIG_DIR']!, 'config.json'), 'utf8')).toBe(JSON.stringify(oldConfig))
  })

  it('迁移标记权限为 0600', () => {
    migrateLegacyData(codec)
    const marker = join(newHome, 'migration-v1.done')
    expect(existsSync(marker)).toBe(true)
    expect(statSync(marker).mode & 0o777).toBe(0o600)
  })
})
