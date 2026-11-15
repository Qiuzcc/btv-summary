import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadAudio, writeCookieFile, type SpawnFn } from '../src/main/core/audio'

function tmpDir(): string {
  const dir = join(tmpdir(), 'btv-audio-' + Math.random().toString(36).slice(2, 8))
  mkdirSync(dir, { recursive: true })
  return dir
}

function spawnThatWrites(files: Record<string, Buffer>): ReturnType<typeof vi.fn> {
  return vi.fn(async (_cmd: string, args: string[]) => {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-o' && args[i + 1]) {
        const outTmpl = args[i + 1]
        const d = outTmpl.replace(/audio\.%\(ext\)s$/, '')
        writeFileSync(join(d, 'audio.webm'), files.webm ?? Buffer.from('fake-webm'))
      }
      if (args[i] === '-y' && args[i + 1] === '-i') {
        const mp3 = args[args.length - 1]
        writeFileSync(mp3, files.mp3 ?? Buffer.from('fake-mp3'))
      }
    }
    return { stdout: '', stderr: '', code: 0, process: { on: vi.fn(), kill: vi.fn() } as any }
  })
}

describe('音频模块', () => {
  let dir: string

  beforeEach(() => {
    dir = tmpDir()
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('TR-7.1 audio.mp3 缓存命中直接返回', async () => {
    const mp3 = join(dir, 'audio.mp3')
    writeFileSync(mp3, 'cached')
    const spawnFn = vi.fn()
    const result = await downloadAudio('https://x', dir, { spawnFn: spawnFn as unknown as SpawnFn })
    expect(result).toBe(mp3)
    expect(spawnFn).not.toHaveBeenCalled()
  })

  it('TR-7.1 旧 audio.wav 转码复用，不调用 yt-dlp', async () => {
    writeFileSync(join(dir, 'audio.wav'), 'wav')
    const spawnFn = vi.fn(async (cmd: string) => {
      if (cmd.includes('ffmpeg')) {
        writeFileSync(join(dir, 'audio.mp3'), 'mp3')
      }
      return { stdout: '', stderr: '', code: 0, process: { on: vi.fn() } as any }
    })
    const result = await downloadAudio('https://x', dir, { spawnFn: spawnFn as unknown as SpawnFn, ffmpegPath: 'ffmpeg' })
    expect(result).toBe(join(dir, 'audio.mp3'))
    const cmds = spawnFn.mock.calls.map((c) => c[0])
    expect(cmds.every((c: unknown) => String(c).includes('ffmpeg'))).toBe(true)
    expect(cmds.some((c: unknown) => String(c).includes('yt-dlp'))).toBe(false)
  })

  it('ffmpeg 缺失报中文错误', async () => {
    const spawnFn = vi.fn(async () => {
      throw new Error('not found')
    })
    await expect(
      downloadAudio('https://x', dir, { spawnFn: spawnFn as unknown as SpawnFn, ffmpegPath: '/no/such/ffmpeg' })
    ).rejects.toThrow(/未找到 ffmpeg/)
  })

  it('下载 + 转码全流程', async () => {
    const spawnFn = spawnThatWrites({})
    const result = await downloadAudio('https://x', dir, { spawnFn: spawnFn as unknown as SpawnFn, ytDlpPath: 'yt-dlp', ffmpegPath: 'ffmpeg' })
    expect(result).toBe(join(dir, 'audio.mp3'))
    expect(existsSync(join(dir, 'audio.mp3'))).toBe(true)
    const cmds = spawnFn.mock.calls.map((c: unknown[]) => c[0])
    expect(cmds).toContain('yt-dlp')
    expect(cmds).toContain('ffmpeg')
  })

  it('cookies.txt 生成内容与权限 0600', () => {
    const cookie = writeCookieFile(dir, 'sess-secret')
    expect(cookie).toBe(join(dir, 'cookies.txt'))
    const content = readFileSync(cookie!, 'utf8')
    expect(content).toContain('SESSDATA\tsess-secret')
    expect(statSync(cookie!).mode & 0o777).toBe(0o600)
  })

  it('cookies.txt sessdata 为空返回 null', () => {
    expect(writeCookieFile(dir, '')).toBeNull()
  })
})
