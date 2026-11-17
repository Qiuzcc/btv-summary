/**
 * LLM 调用：OpenAI 兼容 /chat/completions，指数退避重试。
 * 逐函数对齐 archive/btv/llm.py；fetch 可注入以便单测。
 */
import type { AppConfig } from './config'

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504])

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatOptions {
  temperature?: number
  timeout?: number
  /** 注入 fetch，便于测试 */
  fetchImpl?: typeof fetch
  /** 注入 sleep，便于测试用 fake timers */
  sleep?: (ms: number) => Promise<void>
  /** 注入时钟，便于测试日志时间戳（暂未使用，预留） */
  now?: () => number
}

function retryAfterMs(headers: Headers): number | null {
  const value = headers.get('Retry-After')
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(0, Math.round(seconds * 1000))
  // 非数字日期格式忽略（对齐 Python 仅处理 float）
  return null
}

export async function chat(
  config: AppConfig,
  messages: ChatMessage[],
  options: ChatOptions = {}
): Promise<string> {
  const llm = config.llm
  const apiKey = llm.api_key || ''
  const baseUrl = (llm.base_url || '').replace(/\/+$/, '')
  if (!apiKey) {
    throw new Error('未配置 LLM，请执行：btv config set llm.api_key sk-xxx')
  }
  if (!baseUrl) {
    throw new Error('未配置 llm.base_url')
  }

  const maxRetries = Math.max(0, Math.trunc(llm.max_retries ?? 3))
  const model = llm.model || 'deepseek-chat'
  const temperature = options.temperature ?? llm.temperature ?? 0.3
  const timeout = options.timeout ?? 240
  const fetchImpl = options.fetchImpl ?? fetch
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))

  const payload = {
    model,
    messages,
    temperature,
    stream: false
  }
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  }
  const url = baseUrl + '/chat/completions'

  let lastError = ''
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response: Response
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeout * 1000)
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal
        })
      } finally {
        clearTimeout(timer)
      }
    } catch (error) {
      lastError = `网络错误：${(error as Error).message}`
      if (attempt >= maxRetries) break
      const delay = 2 ** attempt
      // eslint-disable-next-line no-console
      console.error(
        `[btv] LLM 请求失败（${lastError}），${delay}s 后重试（${attempt + 1}/${maxRetries}）`
      )
      await sleep(delay * 1000)
      continue
    }

    if (response.status < 400) {
      let data: any
      try {
        data = await response.json()
      } catch {
        throw new Error('LLM 返回格式异常：响应不是合法 JSON')
      }
      let content: string
      try {
        content = String(data['choices'][0]['message']['content']).trim()
      } catch {
        throw new Error(`LLM 返回格式异常：${JSON.stringify(data).slice(0, 300)}`)
      }
      return content
    }

    const text = await response.text().catch(() => '')
    lastError = `HTTP ${response.status}：${text.slice(0, 400)}`
    if (!RETRYABLE_STATUS.has(response.status)) {
      throw new Error(`LLM 请求失败 ${lastError}`)
    }
    if (attempt >= maxRetries) break

    let waitMs = retryAfterMs(response.headers)
    if (waitMs === null) waitMs = (2 ** attempt) * 1000
    // eslint-disable-next-line no-console
    console.error(
      `[btv] LLM 服务临时故障（${lastError.slice(0, 120)}），${Math.round(waitMs / 1000)}s 后重试（${attempt + 1}/${maxRetries}）`
    )
    await sleep(waitMs)
  }

  throw new Error(`LLM 请求重试 ${maxRetries} 次后仍失败：${lastError}`)
}
