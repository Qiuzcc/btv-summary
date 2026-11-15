/**
 * 音频下载与 ffmpeg 转码。对齐 archive/btv/audio.py：
 * 随包 yt-dlp 二进制 + 随包 ffmpeg；cookies.txt 0600；16k/mono/64k mp3；
 * audio.mp3 缓存命中与 audio.wav 旧缓存转码复用。
 * spawn 与二进制路径可注入以便单测。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, extname, basename } from 'node:path'
import { resourcesDir } from './paths'

export interface Binaries {
  ytDlp: string
  ffmpeg: string
}

export interface SpawnResult {
  stdout: string
  stderr: string
  code: number
  process: ChildProcessWithoutNullStreams
}

export type SpawnFn = (
  command: string,
  args: string[],
  opts?: { signal?: AbortSignal }
) => Promise<SpawnResult>

/** 子进程句柄注册表：任务取消时统一 SIGTERM */
export interface ChildProcessRegistry {
  register(child: ChildProcessWithoutNullStreams): void
}

const noopRegistry: ChildProcessRegistry = {
  register() {
    /* 默认不登记，生产由 TaskManager 注入 */
  }
}

function defaultSpawn(command: string, args: string[], opts: { signal?: AbortSignal } = {}): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { signal: opts.signal })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? -1, process: child }))
  })
}

/** 解析随包二进制：resources/yt-dlp、resources/ffmpeg（平台后缀在打包时处理）
 *  随包文件缺失时回退到 PATH 中的同名命令，便于开发态直接使用系统安装的版本 */
export function resolveBinaries(baseDir = resourcesDir()): Binaries {
  const platformExt = process.platform === 'win32' ? '.exe' : ''
  const resolveOne = (name: string): string => {
    const bundled = join(baseDir, name + platformExt)
    return existsSync(bundled) ? bundled : name
  }
  return { ytDlp: resolveOne('yt-dlp'), ffmpeg: resolveOne('ffmpeg') }
}

/** 检测 ffmpeg 是否存在（随包或系统 PATH） */
export async function ffmpegAvailable(
  ffmpegPath: string,
  spawnFn: SpawnFn = defaultSpawn
): Promise<boolean> {
  if (existsSync(ffmpegPath)) return true
  try {
    const result = await spawnFn('ffmpeg', ['-version'])
    return result.code === 0
  } catch {
    return false
  }
}

/** 写入 Netscape cookies.txt，权限 0600 */
export function writeCookieFile(destDir: string, sessdata: string, cookiePath?: string): string | null {
  if (cookiePath) return cookiePath
  if (!sessdata) return null
  const path = join(destDir, 'cookies.txt')
  writeFileSync(
    path,
    '# Netscape HTTP Cookie File\n' +
      '.bilibili.com\tTRUE\t/\tFALSE\t0\tSESSDATA\t' +
      sessdata +
      '\n',
    'utf8'
  )
  chmodSync(path, 0o600)
  return path
}

async function transcodeToMp3(
  source: string,
  mp3Path: string,
  ffmpegPath: string,
  spawnFn: SpawnFn = defaultSpawn,
  registry: ChildProcessRegistry = noopRegistry,
  signal?: AbortSignal
): Promise<void> {
  const result = await spawnFn(
    ffmpegPath,
    ['-y', '-i', source, '-ar', '16000', '-ac', '1', '-vn', '-b:a', '64k', mp3Path],
    { signal }
  )
  registry.register(result.process)
  if (result.code !== 0) {
    throw new Error(`音频转码失败：${result.stderr.slice(-500)}`)
  }
}

export interface DownloadAudioOptions {
  sessdata?: string
  cookiePath?: string
  ytDlpPath?: string
  ffmpegPath?: string
  spawnFn?: SpawnFn
  registry?: ChildProcessRegistry
  signal?: AbortSignal
}

/**
 * 下载最佳音质音频并转码为 16k/mono/64k mp3。
 * 对齐 audio.download_audio：audio.mp3 命中即返回；audio.wav 旧缓存转码复用。
 */
export async function downloadAudio(
  url: string,
  destDir: string,
  options: DownloadAudioOptions = {}
): Promise<string> {
  const sessdata = options.sessdata ?? ''
  const spawnFn = options.spawnFn ?? defaultSpawn
  const registry = options.registry ?? noopRegistry
  const binaries = resolveBinaries()
  const ytDlpPath = options.ytDlpPath ?? binaries.ytDlp
  const ffmpegPath = options.ffmpegPath ?? binaries.ffmpeg

  mkdirSync(destDir, { recursive: true })
  const mp3Path = join(destDir, 'audio.mp3')
  if (existsSync(mp3Path)) return mp3Path

  if (!(await ffmpegAvailable(ffmpegPath, spawnFn))) {
    throw new Error('未找到 ffmpeg，请先安装：brew install ffmpeg')
  }

  // 兼容旧版缓存的 wav：直接转码
  const legacyWav = join(destDir, 'audio.wav')
  if (existsSync(legacyWav)) {
    await transcodeToMp3(legacyWav, mp3Path, ffmpegPath, spawnFn, registry, options.signal)
    return mp3Path
  }

  const cookieFile = writeCookieFile(destDir, sessdata, options.cookiePath)
  const args = [
    '-f',
    'bestaudio/best',
    '-o',
    join(destDir, 'audio.%(ext)s'),
    '--no-playlist',
    '--quiet',
    '--no-warnings',
    '--no-progress'
  ]
  if (cookieFile) args.push('--cookies', cookieFile)
  args.push(url)

  const result = await spawnFn(ytDlpPath, args, { signal: options.signal })
  registry.register(result.process)
  if (result.code !== 0) {
    throw new Error(`音频下载失败：${result.stderr.slice(-500) || result.stdout.slice(-500)}`)
  }

  const sources = readdirSync(destDir)
    .filter((name) => name.startsWith('audio.'))
    .filter((name) => {
      const ext = extname(name).toLowerCase()
      return ext !== '.part' && ext !== '.wav' && ext !== '.mp3'
    })
    .map((name) => join(destDir, name))
  if (sources.length === 0) {
    throw new Error('yt-dlp 没有产出音频文件')
  }
  const source = sources.reduce((a, b) => (statSync(a).size >= statSync(b).size ? a : b))

  await transcodeToMp3(source, mp3Path, ffmpegPath, spawnFn, registry, options.signal)
  return mp3Path
}

export { basename }
