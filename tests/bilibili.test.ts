import { describe, expect, it, vi } from 'vitest'
import {
  BilibiliClient,
  getMixinKey,
  quotePlus,
  resolveBvid
} from '../src/main/core/bilibili'

/**
 * 下列 MIXIN/QUERY/WRID/ENC 常量由 archive/btv/bilibili.py 同输入预计算，
 * 任何一项漂移都意味着 Node 重写与 Python 行为不一致。
 */
const IMG_KEY = '7cd084941338484aae1ad9425b84077c'
const SUB_KEY = '4932caff0ff746eab6f01bf08b70ac45'
const EXPECTED_MIXIN = 'ea1db124af3c7062474693fa704f4ff8'
const EXPECTED_QUERY =
  'aid=170001&bvid=BV1TEST12345&cid=280002&wts=1700000000'
const EXPECTED_WRID = '4a2120cab9d51d3fc1eeacc2cf1c9de9'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    statusText: 'OK'
  })
}

describe('WBI 签名与 Python 对拍', () => {
  it('mixinKey 与混淆表结果逐字符一致', () => {
    expect(getMixinKey(IMG_KEY + SUB_KEY)).toBe(EXPECTED_MIXIN)
  })

  it('quote_plus 编码（空格、加号、标点、波浪号）一致', () => {
    expect(quotePlus('a b+c!*()~')).toBe('a+b%2Bc%21%2A%28%29~')
  })

  it('固定时钟下 wts 排序 query 与 w_rid 完全一致', () => {
    const client = new BilibiliClient('', {
      now: () => 1_700_000_000,
      initialKeys: [IMG_KEY, SUB_KEY]
    })
    const signed = client.sign({
      aid: 170001,
      cid: 280002,
      bvid: 'BV1TEST12345'
    })
    expect(signed['wts']).toBe('1700000000')
    // 签名输入 query 不含 w_rid（与 Python 一致：先算 query 再追加 w_rid）
    const query = Object.keys(signed)
      .filter((key) => key !== 'w_rid')
      .sort()
      .map((key) => `${quotePlus(key)}=${quotePlus(signed[key])}`)
      .join('&')
    expect(query).toBe(EXPECTED_QUERY)
    expect(signed['w_rid']).toBe(EXPECTED_WRID)
  })
})

describe('resolveBvid', () => {
  it('裸 BV 号与完整链接直接提取', async () => {
    const fetchImpl = vi.fn()
    expect(await resolveBvid('BV1TEST12345', fetchImpl)).toBe('BV1TEST12345')
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(await resolveBvid('https://www.bilibili.com/video/BV1TEST12345/', fetchImpl)).toBe(
      'BV1TEST12345'
    )
  })

  it('短链跟随重定向后从最终 URL 提取', async () => {
    const fetchImpl = vi.fn(async () => {
      const response = new Response('not found', { status: 200 })
      Object.defineProperty(response, 'url', {
        value: 'https://www.bilibili.com/video/BV1SHORT1234/'
      })
      return response
    })
    expect(await resolveBvid('https://b23.tv/abc', fetchImpl)).toBe('BV1SHORT1234')
  })

  it('无法解析时抛出中文错误', async () => {
    const fetchImpl = vi.fn(async () => new Response('plain page', { status: 200 }))
    await expect(resolveBvid('https://b23.tv/xyz', fetchImpl)).rejects.toThrow(
      /无法解析 BV 号/
    )
  })
})

describe('BilibiliClient 接口行为', () => {
  it('getMeta 多 P 取第一页 cid，并映射标题/UP/时长', async () => {
    const fetchImpl = vi.fn(async (input: string, _init?: RequestInit) => {
      expect(input).toContain('x/web-interface/view')
      return jsonResponse({
        code: 0,
        data: {
          aid: 111,
          cid: 0,
          pages: [{ cid: 222 }],
          title: '测试视频',
          owner: { name: 'UP主' },
          duration: 600
        }
      })
    })
    const client = new BilibiliClient('sess', { fetchImpl })
    const meta = await client.getMeta('BV1TEST12345')
    expect(meta).toEqual({
      aid: 111,
      cid: 222,
      title: '测试视频',
      owner: 'UP主',
      duration: 600
    })
    const headers = fetchImpl.mock.calls[0][1]?.headers as
      | Record<string, string>
      | undefined
    expect(headers?.['Cookie']).toBe('SESSDATA=sess')
  })

  it('接口 code 非 0 时抛含 code/message 的错误', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ code: -403, message: '访问权限不足' })
    )
    const client = new BilibiliClient('', { fetchImpl })
    await expect(client.getMeta('BV1')).rejects.toThrow(
      'B 站接口错误 -403: 访问权限不足'
    )
  })

  it('字幕按语言优先级选择并解析为分段', async () => {
    const routes: Record<string, unknown> = {
      view: {
        code: 0,
        data: { aid: 1, cid: 2, title: 't', owner: { name: 'u' }, duration: 10 }
      },
      nav: {
        code: 0,
        data: {
          wbi_img: {
            img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
            sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png'
          }
        }
      },
      player: {
        code: 0,
        data: {
          subtitle: {
            subtitles: [
              { lan: 'en-US', subtitle_url: '//example.com/en.json' },
              { lan: 'zh-Hans', subtitle_url: '//example.com/zh.json' }
            ]
          }
        }
      },
      zh: { body: [{ from: 0, to: 1.5, content: ' 你好 ' }, { from: 1.5, to: 3, content: '' }] }
    }
    const fetchImpl = vi.fn(async (input: string) => {
      const url = String(input)
      if (url.includes('view')) return jsonResponse(routes['view'])
      if (url.includes('nav')) return jsonResponse(routes['nav'])
      if (url.includes('player')) return jsonResponse(routes['player'])
      if (url.includes('zh.json')) return jsonResponse(routes['zh'])
      throw new Error('unexpected ' + url)
    })
    const client = new BilibiliClient('sess', { fetchImpl })
    const transcript = await client.getTranscript('BV1TEST12345')
    expect(transcript.source).toBe('subtitle')
    expect(transcript.segments).toEqual([{ start: 0, end: 1.5, text: '你好' }])
    // zh-Hans 优先于 en-US
    expect(String(fetchImpl.mock.calls.at(-1)?.[0])).toContain('zh.json')
  })

  it('无字幕且未登录时报预期降级错误', async () => {
    const fetchImpl = vi.fn(async (input: string) => {
      if (input.includes('view')) {
        return jsonResponse({
          code: 0,
          data: { aid: 1, cid: 2, title: 't', owner: { name: 'u' }, duration: 10 }
        })
      }
      if (input.includes('nav')) {
        return jsonResponse({
          code: 0,
          data: {
            wbi_img: {
              img_url: 'https://x/7cd084941338484aae1ad9425b84077c.png',
              sub_url: 'https://x/4932caff0ff746eab6f01bf08b70ac45.png'
            }
          }
        })
      }
      return jsonResponse({ code: 0, data: { subtitle: { subtitles: [] } } })
    })
    const client = new BilibiliClient('', { fetchImpl })
    await expect(client.getTranscript('BV1')).rejects.toThrow(
      /该视频没有可用字幕（未提供 SESSDATA）/
    )
  })
})
