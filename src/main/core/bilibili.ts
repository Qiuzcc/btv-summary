/**
 * B 站接口：BV 解析、WBI 签名、视频元信息与字幕获取。
 * 逐函数对齐 archive/btv/bilibili.py，fetch 可注入以便单测。
 */
import { createHash } from 'node:crypto'
import type { Segment, Transcript } from '../../shared/types'

const VIEW_URL = 'https://api.bilibili.com/x/web-interface/view'
const PLAYER_URL = 'https://api.bilibili.com/x/player/wbi/v2'
const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav'

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

const BV_RE = /(BV[0-9A-Za-z]{10})/

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33,
  9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17,
  0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
]

const SUBTITLE_PRIORITY = [
  'zh-Hans',
  'zh-CN',
  'ai-zh',
  'zh',
  'zh-Hant'
]

export interface FetchLike {
  (input: string, init?: RequestInit): Promise<Response>
}

/** 等价 Python urllib.parse.quote_plus：空格→+，非安全字节→大写百分号 */
export function quotePlus(value: string): string {
  const safe = /[A-Za-z0-9_.-~]/
  return Array.from(value)
    .map((ch) => {
      if (safe.test(ch)) return ch
      if (ch === ' ') return '+'
      return Array.from(Buffer.from(ch, 'utf8'))
        .map((b) => '%' + b.toString(16).toUpperCase().padStart(2, '0'))
        .join('')
    })
    .join('')
}

export function getMixinKey(original: string): string {
  return MIXIN_KEY_ENC_TAB.map((index) => original[index]).join('').slice(0, 32)
}

function keyFromUrl(url: string): string {
  return url.split('/').pop()!.split('.', 1)[0]
}

/** 对齐 resolve_bvid：裸 BV / 完整链接 / b23 短链重定向 */
export async function resolveBvid(
  text: string,
  fetchImpl: FetchLike = fetch
): Promise<string> {
  const direct = text.match(BV_RE)
  if (direct) return direct[1]

  if (text.startsWith('http') || text.includes('b23.tv')) {
    let response: Response
    try {
      response = await fetchImpl(text, {
        headers: { 'User-Agent': USER_AGENT },
        redirect: 'follow'
      })
    } catch (error) {
      throw new Error(`短链接解析失败：${(error as Error).message}`)
    }
    const body = (await response.text()).slice(0, 5000)
    const match = response.url.match(BV_RE) || body.match(BV_RE)
    if (match) return match[1]
  }
  throw new Error(
    '无法解析 BV 号，请提供 https://www.bilibili.com/video/BV... 或 BV 号'
  )
}

export interface VideoMeta {
  aid: number
  cid: number
  title: string
  owner: string
  duration: number
}

export interface BilibiliOptions {
  fetchImpl?: FetchLike
  /** 注入时钟，签名测试可固定 wts */
  now?: () => number
  timeoutMs?: number
  /** 直接注入 WBI 密钥，跳过 nav 请求，仅供测试与密钥复用场景 */
  initialKeys?: [string, string]
}

export class BilibiliClient {
  private readonly fetchImpl: FetchLike
  private readonly now: () => number
  private readonly timeoutMs: number
  private wbiKeys: [string, string] | null = null

  constructor(
    private readonly sessdata = '',
    options: BilibiliOptions = {}
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000))
    this.timeoutMs = options.timeoutMs ?? 20_000
    this.wbiKeys = options.initialKeys ?? null
  }

  private headers(referer = 'https://www.bilibili.com/'): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      Referer: referer
    }
    if (this.sessdata) headers['Cookie'] = `SESSDATA=${this.sessdata}`
    return headers
  }

  async getMeta(bvid: string): Promise<VideoMeta> {
    const view = await this.request<{
      aid?: number
      cid?: number
      title?: string
      owner?: { name?: string }
      duration?: number
      pages?: Array<{ cid?: number }>
    }>(VIEW_URL, { bvid })

    let cid = view.cid
    if (!cid && view.pages?.length) cid = view.pages[0]?.cid
    if (!cid) throw new Error('未能获取视频 cid')

    return {
      aid: view.aid!,
      cid,
      title: view.title || bvid,
      owner: view.owner?.name || '',
      duration: Math.trunc(view.duration || 0)
    }
  }

  async getTranscript(bvid: string): Promise<Transcript> {
    const meta = await this.getMeta(bvid)
    await this.ensureWbiKeys()
    const player = await this.request<{
      subtitle?: { subtitles?: Array<{ lan?: string; subtitle_url?: string }> }
    }>(
      PLAYER_URL,
      { aid: meta.aid, cid: meta.cid, bvid },
      true,
      `https://www.bilibili.com/video/${bvid}/`
    )

    const subtitles = player.subtitle?.subtitles || []
    if (subtitles.length === 0) {
      const hint = this.sessdata ? 'SESSDATA 可能已失效' : '未提供 SESSDATA'
      throw new Error(`该视频没有可用字幕（${hint}）`)
    }

    const chosen = this.pickSubtitle(subtitles)
    const segments = await this.fetchSubtitle(chosen.subtitle_url!)
    if (segments.length === 0) throw new Error('字幕文件内容为空')

    return {
      bvid,
      title: meta.title,
      owner: meta.owner,
      duration: meta.duration,
      source: 'subtitle',
      segments
    }
  }

  private pickSubtitle(
    subtitles: Array<{ lan?: string; subtitle_url?: string }>
  ): { lan?: string; subtitle_url?: string } {
    for (const language of SUBTITLE_PRIORITY) {
      const hit = subtitles.find(
        (item) => item.lan === language && Boolean(item.subtitle_url)
      )
      if (hit) return hit
    }
    const zh = subtitles.find(
      (item) => (item.lan || '').startsWith('zh') && Boolean(item.subtitle_url)
    )
    if (zh) return zh
    const any = subtitles.find((item) => Boolean(item.subtitle_url))
    if (any) return any
    throw new Error('字幕列表中没有可下载的字幕地址')
  }

  private async fetchSubtitle(subtitleUrl: string): Promise<Segment[]> {
    const url = subtitleUrl.startsWith('http')
      ? subtitleUrl
      : 'https:' + subtitleUrl
    const response = await this.fetchImpl(url, {
      headers: this.headers(),
      signal: AbortSignal.timeout(this.timeoutMs)
    })
    if (!response.ok) throw new Error(`字幕下载失败：HTTP ${response.status}`)
    const body = (await response.json()) as {
      body?: Array<{ from: number; to: number; content?: string }>
    }
    const segments: Segment[] = []
    for (const item of body.body || []) {
      const text = String(item.content || '').trim()
      if (text) segments.push({ start: Number(item.from), end: Number(item.to), text })
    }
    return segments
  }

  private async request<T>(
    url: string,
    params: Record<string, string | number | null | undefined>,
    wbi = false,
    referer?: string
  ): Promise<T> {
    const query = wbi ? this.sign(params) : params
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (value !== null && value !== undefined) search.set(key, String(value))
    }
    const response = await this.fetchImpl(`${url}?${search.toString()}`, {
      headers: this.headers(referer),
      signal: AbortSignal.timeout(this.timeoutMs)
    })
    if (!response.ok) {
      throw new Error(`B 站接口 HTTP ${response.status}：${(await response.text()).slice(0, 300)}`)
    }
    const payload = (await response.json()) as {
      code: number
      message?: string
      data?: T
    }
    if (payload.code !== 0) {
      throw new Error(`B 站接口错误 ${payload.code}: ${payload.message}`)
    }
    return (payload.data || {}) as T
  }

  /** 对齐 _sign：wts + 排序 + quote_plus query + MD5 w_rid */
  sign(params: Record<string, string | number | null | undefined>): Record<string, string> {
    const [imgKey, subKey] = this.getWbiKeys()
    const mixinKey = getMixinKey(imgKey + subKey)
    const signed: Record<string, string> = {}
    for (const [key, value] of Object.entries(params)) {
      if (value !== null && value !== undefined) signed[key] = String(value)
    }
    signed['wts'] = String(this.now())
    const query = Object.keys(signed)
      .sort()
      .map((key) => `${quotePlus(key)}=${quotePlus(signed[key])}`)
      .join('&')
    signed['w_rid'] = createHash('md5').update(query + mixinKey, 'utf8').digest('hex')
    return signed
  }

  private getWbiKeys(): [string, string] {
    if (this.wbiKeys) return this.wbiKeys
    throw new Error('WBI 密钥尚未初始化，请先调用 initWbiKeys()')
  }

  /** 从 nav 接口获取并缓存 WBI 密钥（对齐 _get_wbi_keys） */
  async initWbiKeys(): Promise<[string, string]> {
    if (this.wbiKeys) return this.wbiKeys
    const data = await this.request<{
      wbi_img?: { img_url?: string; sub_url?: string }
    }>(NAV_URL, {})
    const wbiImg = data.wbi_img || {}
    const imgKey = keyFromUrl(wbiImg.img_url || '')
    const subKey = keyFromUrl(wbiImg.sub_url || '')
    if (!imgKey || !subKey) throw new Error('获取 WBI 签名密钥失败')
    this.wbiKeys = [imgKey, subKey]
    return this.wbiKeys
  }

  /** 供 player 调用前确保密钥就绪 */
  async ensureWbiKeys(): Promise<void> {
    await this.initWbiKeys()
  }
}
