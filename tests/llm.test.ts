import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type AppConfig } from '../src/main/core/config'
import { chat, type ChatMessage } from '../src/main/core/llm'

function baseConfig(): AppConfig {
  const cfg = structuredClone(DEFAULT_CONFIG)
  cfg.llm.api_key = 'sk-test'
  cfg.llm.base_url = 'https://api.example.com/v1'
  cfg.llm.max_retries = 2
  return cfg
}

const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }]

describe('LLM 调用', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('成功解析 choices 内容并回调 usage', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '  hello  ' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 }
        }),
        { status: 200 }
      )
    )
    const onUsage = vi.fn()
    const result = await chat(baseConfig(), messages, { fetchImpl, onUsage, sleep: vi.fn() })
    expect(result).toBe('hello')
    expect(onUsage).toHaveBeenCalledWith({ model: 'deepseek-chat', prompt_tokens: 10, completion_tokens: 5 })
  })

  it('TR-6.2 未配置 api_key 或 base_url 立即抛错', async () => {
    const noKey = baseConfig()
    noKey.llm.api_key = ''
    await expect(chat(noKey, messages)).rejects.toThrow(/未配置 LLM/)

    const noBase = baseConfig()
    noBase.llm.base_url = ''
    await expect(chat(noBase, messages)).rejects.toThrow(/未配置 llm.base_url/)
  })

  it('429 + Retry-After 尊重等待时长', async () => {
    const fetchImpl = vi.fn()
    fetchImpl
      .mockResolvedValueOnce(
        new Response('rate limit', { status: 429, headers: { 'Retry-After': '5' } })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })
      )
    const sleep = vi.fn().mockResolvedValue(undefined)
    await chat(baseConfig(), messages, { fetchImpl, sleep })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(5000)
  })

  it('5xx 重试耗尽后抛出', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('err', { status: 503 }))
    const sleep = vi.fn().mockResolvedValue(undefined)
    await expect(chat(baseConfig(), messages, { fetchImpl, sleep })).rejects.toThrow(/重试 2 次后仍失败/)
    expect(fetchImpl).toHaveBeenCalledTimes(3) // attempt 0,1,2
    // 退避 2^0, 2^1
    expect(sleep).toHaveBeenNthCalledWith(1, 1000)
    expect(sleep).toHaveBeenNthCalledWith(2, 2000)
  })

  it('非重试 4xx 立即失败', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('unauth', { status: 401 }))
    const sleep = vi.fn().mockResolvedValue(undefined)
    await expect(chat(baseConfig(), messages, { fetchImpl, sleep })).rejects.toThrow(/LLM 请求失败 HTTP 401/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('网络错误退避重试', async () => {
    const fetchImpl = vi.fn()
    fetchImpl.mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: 'recovered' } }] }), { status: 200 })
    )
    const sleep = vi.fn().mockResolvedValue(undefined)
    const result = await chat(baseConfig(), messages, { fetchImpl, sleep })
    expect(result).toBe('recovered')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(1000)
  })

  it('异常响应体显式报错', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [] }), { status: 200 })
    )
    await expect(chat(baseConfig(), messages, { fetchImpl, sleep: vi.fn() })).rejects.toThrow(/返回格式异常/)
  })
})
