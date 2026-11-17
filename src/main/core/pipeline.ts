/**
 * 单任务执行管线：解析 BV → 字幕/转写 → 总结 → 写盘。
 * 对齐 archive/btv/cli.py 的 _load_transcript + cmd_summarize 流程，
 * 并接入 LLM/ASR 全局限流信号量与子进程注册（供取消回收）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AppConfig } from './config'
import { BilibiliClient, resolveBvid } from './bilibili'
import { downloadAudio, type ChildProcessRegistry } from './audio'
import { transcribe } from './asr'
import { summarize } from './summarize'
import { bvCacheDir, outputBaseDir } from './paths'
import type { Semaphore } from './semaphore'
import { chat, type ChatOptions } from './llm'
import { safeDirname, serializeTranscript } from '../../shared/transcript'
import type { Segment, Transcript } from '../../shared/types'
import type { TaskParams } from '../../shared/types'

export interface PipelineDeps {
  config: AppConfig
  params: TaskParams
  llmSemaphore: Semaphore
  asrSemaphore: Semaphore
  registry: ChildProcessRegistry
  signal: AbortSignal
  progress: (phase: string, message: string, done: number, total: number) => void
  /** 测试可注入 fetch，默认全局 fetch */
  fetchImpl?: typeof fetch
}

function outputDir(transcript: Transcript): string {
  return join(outputBaseDir(), safeDirname(transcript.title, transcript.bvid))
}

function outputPath(params: TaskParams, transcript: Transcript, extension: string): string {
  if (params.output) {
    const candidate = params.output
    const lower = candidate.toLowerCase()
    if (lower.endsWith('.md') || lower.endsWith('.json')) {
      mkdirSync(dirname(candidate), { recursive: true })
      return candidate
    }
    mkdirSync(candidate, { recursive: true })
    return join(candidate, `summary.${extension}`)
  }
  const dir = outputDir(transcript)
  mkdirSync(dir, { recursive: true })
  return join(dir, `summary.${extension}`)
}

/** 用 LLM 信号量包装 chat：调用前后 acquire/release */
function withLlmSemaphore(
  semaphore: Semaphore,
  signal: AbortSignal
): typeof chat {
  return async (config, messages, options: ChatOptions = {}) => {
    await semaphore.acquire()
    try {
      return await chat(config, messages, {
        ...options,
        // 把任务级 abort 透传给 fetch，取消时中断在途请求
        fetchImpl: options.fetchImpl ?? ((input, init) =>
          (options.fetchImpl ?? fetch)(input, { ...init, signal })
        )
      })
    } finally {
      semaphore.release()
    }
  }
}

export interface PipelineResult {
  transcript: Transcript
  markdown: string
  outputPath: string
}

/** 对齐 cli._load_transcript：字幕优先，失败降级音频转写 */
async function loadTranscript(
  bvid: string,
  config: AppConfig,
  params: TaskParams,
  asrSemaphore: Semaphore,
  registry: ChildProcessRegistry,
  signal: AbortSignal,
  progress: PipelineDeps['progress'],
  fetchImpl?: typeof fetch
): Promise<Transcript> {
  const sessdata = config.bilibili.sessdata || ''
  const client = new BilibiliClient(sessdata, { fetchImpl })

  let meta: Awaited<ReturnType<BilibiliClient['getMeta']>> | null = null
  try {
    meta = await client.getMeta(bvid)
    progress('meta', `读取视频信息：${meta.title}`, 0, 1)
  } catch (error) {
    progress('meta', `读取视频信息失败：${(error as Error).message}`, 0, 1)
  }

  if (!params.noSubtitle) {
    if (!sessdata) {
      progress('transcript', '未登录 B 站，跳过字幕，改用音频转写', 0, 1)
    } else {
      try {
        const transcript = await client.getTranscript(bvid)
        progress('transcript', `字幕获取成功，${transcript.segments.length} 段`, 1, 1)
        return transcript
      } catch (error) {
        progress('transcript', `字幕获取失败：${(error as Error).message}，改用音频转写`, 0, 1)
      }
    }
  }

  const url = `https://www.bilibili.com/video/${bvid}/`
  progress('audio', '下载音频中...', 0, 1)
  const audioPath = await downloadAudio(url, bvCacheDir(bvid), {
    sessdata,
    registry,
    signal
  })
  progress('audio', '音频下载完成', 1, 1)

  progress('asr', '开始转写（云端），耗时取决于视频长度...', 0, 1)
  const segments: Segment[] = []
  await asrSemaphore.acquire()
  try {
    const result = await transcribe(
      audioPath,
      config,
      { fetchImpl, signal }
    )
    segments.push(...result)
    const seconds = segments.length > 0 ? Number(segments[segments.length - 1].end) : 0
    progress('asr', `转写中，累计 ${seconds.toFixed(0)}s`, 1, 1)
  } finally {
    asrSemaphore.release()
  }
  progress('asr', `转写完成，${segments.length} 段`, 1, 1)

  const duration = meta ? Math.trunc(meta.duration) : Math.trunc(segments[segments.length - 1]?.end ?? 0)
  return {
    bvid,
    title: meta?.title || bvid,
    owner: meta?.owner || '',
    duration,
    source: 'asr',
    segments
  }
}

export async function runPipeline(deps: PipelineDeps): Promise<PipelineResult> {
  const { config, params, llmSemaphore, asrSemaphore, registry, signal, progress, fetchImpl } = deps

  const bvid = await resolveBvid(params.url, fetchImpl)

  const transcript = await loadTranscript(
    bvid,
    config,
    params,
    asrSemaphore,
    registry,
    signal,
    progress,
    fetchImpl
  )

  // 保存 transcript 缓存
  const bvCache = bvCacheDir(bvid)
  mkdirSync(bvCache, { recursive: true })
  writeFileSync(join(bvCache, 'transcript.json'), JSON.stringify(serializeTranscript(transcript)), 'utf8')

  progress('summarize', `《${transcript.title}》· ${transcript.segments.length} 段 · ${transcript.source}`, 0, 1)

  const llmChat = withLlmSemaphore(llmSemaphore, signal)

  const markdown = await summarize(transcript, config, {
    detail: params.detail,
    chunkSeconds: params.chunkSeconds ?? undefined,
    progress: (message) => progress('summarize', message, 0, 1),
    llmChat
  })

  const extension = params.format === 'md' ? 'md' : 'json'
  const outPath = outputPath(params, transcript, extension)
  if (params.format === 'md') {
    writeFileSync(outPath, markdown + '\n', 'utf8')
  } else {
    writeFileSync(
      outPath,
      JSON.stringify(
        {
          bvid: transcript.bvid,
          title: transcript.title,
          owner: transcript.owner,
          duration: transcript.duration,
          source: transcript.source,
          summary_markdown: markdown
        },
        null,
        2
      ),
      'utf8'
    )
  }

  progress('done', `完成，输出 ${outPath}`, 1, 1)
  return { transcript, markdown, outputPath: outPath }
}
