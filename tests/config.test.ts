import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_CONFIG,
  deepMerge,
  extractSessdata,
  getValue,
  loadConfig,
  maskConfig,
  saveConfig,
  setValue,
  type AppConfig
} from '../src/main/core/config'
import { InsecureTestCodec } from '../src/main/core/secret-codec'

describe('config 深度合并与点路径', () => {
  it('deepMerge 保留默认值并覆盖嵌套字段', () => {
    const merged = deepMerge(structuredClone(DEFAULT_CONFIG), {
      llm: { model: 'Qwen/test' },
      pricing: { asr: { 'm/a': 0.001 } }
    }) as AppConfig
    expect(merged.llm.model).toBe('Qwen/test')
    expect(merged.llm.base_url).toBe(DEFAULT_CONFIG.llm.base_url)
    expect(merged.pricing.asr['m/a']).toBe(0.001)
  })

  it('setValue 支持 JSON 强转与裸字符串回退', () => {
    const config = structuredClone(DEFAULT_CONFIG) as unknown as Record<string, unknown>
    setValue(config, 'llm.max_retries', '5')
    expect(getValue(config, 'llm.max_retries')).toBe(5)
    setValue(config, 'llm.model', 'deepseek-chat')
    expect(getValue(config, 'llm.model')).toBe('deepseek-chat')
  })
})

describe('SESSDATA 提取', () => {
  it('裸值原样返回', () => {
    expect(extractSessdata('  abc123  ')).toBe('abc123')
  })

  it('从完整 Cookie 截取并去分号', () => {
    expect(extractSessdata('foo=1; SESSDATA=secret-value; bar=2')).toBe(
      'secret-value'
    )
  })
})

describe('配置加密落盘与打码', () => {
  let dir: string
  const codec = new InsecureTestCodec()

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'btv-cfg-'))
  })

  const path = (): string => join(dir, 'config.json')

  it('文件缺失时返回默认配置', () => {
    const config = loadConfig(path(), codec)
    expect(config).toEqual(DEFAULT_CONFIG)
  })

  it('坏 JSON 抛出中文错误', () => {
    const file = path()
    saveConfig(DEFAULT_CONFIG, file, codec)
    require('node:fs').writeFileSync(file, '{bad json')
    expect(() => loadConfig(file, codec)).toThrow(/不是合法 JSON/)
  })

  it('密钥以密文信封落盘且可解密回读，权限为 0600', () => {
    const config = structuredClone(DEFAULT_CONFIG)
    config.llm.api_key = 'sk-1234567890abcdef'
    config.bilibili.sessdata = 'sess-data-value'
    const file = path()
    saveConfig(config, file, codec)

    const onDisk = readFileSync(file, 'utf8')
    expect(onDisk).not.toContain('sk-1234567890abcdef')
    expect(onDisk).toContain('enc:v1:')
    expect(statSync(file).mode & 0o777).toBe(0o600)

    const loaded = loadConfig(file, codec)
    expect(loaded.llm.api_key).toBe('sk-1234567890abcdef')
    expect(loaded.bilibili.sessdata).toBe('sess-data-value')
  })

  it('maskConfig 长密钥保留首4末4，短密钥仅星号', () => {
    const config = structuredClone(DEFAULT_CONFIG)
    config.llm.api_key = 'sk-1234567890abcdef'
    config.cloud_asr.api_key = 'short'
    const masked = maskConfig(config)
    expect(masked.llm.api_key).toBe('sk-1****cdef')
    expect(masked.cloud_asr.api_key).toBe('****')
    // 原对象不被修改
    expect(config.llm.api_key).toBe('sk-1234567890abcdef')
  })

  it('兼容迁移期明文密钥：可读且下次保存自动加密', () => {
    const file = path()
    const plain = structuredClone(DEFAULT_CONFIG)
    plain.llm.api_key = 'sk-plaintext'
    require('node:fs').writeFileSync(file, JSON.stringify(plain))
    const loaded = loadConfig(file, codec)
    expect(loaded.llm.api_key).toBe('sk-plaintext')
    saveConfig(loaded, file, codec)
    expect(readFileSync(file, 'utf8')).not.toContain('sk-plaintext')
  })
})
