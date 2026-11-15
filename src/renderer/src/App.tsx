import { useCallback, useEffect, useState, type JSX } from 'react'
import type { TaskEvent } from '../../shared/api-contract'
import type { AppConfig, TaskParams, TaskRecord } from '../../shared/types'

type Tab = 'new' | 'tasks' | 'history' | 'settings' | 'cost'

const TABS: { id: Tab; label: string }[] = [
  { id: 'new', label: '新建任务' },
  { id: 'tasks', label: '任务列表' },
  { id: 'history', label: '历史结果' },
  { id: 'settings', label: '设置' },
  { id: 'cost', label: '成本统计' }
]

const STATE_LABEL: Record<string, string> = {
  queued: '排队',
  running: '运行中',
  cancelling: '取消中',
  done: '完成',
  error: '失败',
  cancelled: '已取消',
  interrupted: '已中断'
}

export default function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>('new')
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [refresh, setRefresh] = useState(0)

  const reloadTasks = useCallback(() => {
    void window.btv.task.list().then(setTasks)
  }, [])

  useEffect(() => {
    reloadTasks()
    const off = window.btv.task.onEvent((_event: TaskEvent) => {
      reloadTasks()
    })
    return off
  }, [reloadTasks, refresh])

  return (
    <div className="flex h-full bg-slate-50 text-slate-800">
      <nav className="flex w-44 flex-col gap-1 border-r border-slate-200 bg-white p-3">
        <div className="px-2 py-3 text-lg font-bold text-slate-900">btv-summary</div>
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`rounded-md px-3 py-2 text-left text-sm transition ${
              tab === t.id
                ? 'bg-slate-900 text-white'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <main className="flex-1 overflow-auto p-6">
        {tab === 'new' && <NewTaskPage onSubmitted={() => setRefresh((n) => n + 1)} />}
        {tab === 'tasks' && <TasksPage tasks={tasks} onChange={reloadTasks} />}
        {tab === 'history' && <HistoryPage />}
        {tab === 'settings' && <SettingsPage />}
        {tab === 'cost' && <CostPage />}
      </main>
    </div>
  )
}

function NewTaskPage({ onSubmitted }: { onSubmitted: () => void }): JSX.Element {
  const [url, setUrl] = useState('')
  const [detail, setDetail] = useState<'brief' | 'normal' | 'deep'>('normal')
  const [format, setFormat] = useState<'md' | 'json'>('md')
  const [noSubtitle, setNoSubtitle] = useState(false)
  const [refresh, setRefresh] = useState(false)
  const [output, setOutput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function submit(): Promise<void> {
    if (!url.trim()) {
      setError('请输入 BV 号或视频链接')
      return
    }
    setError(null)
    setSubmitting(true)
    try {
      const params: TaskParams = {
        url: url.trim(),
        detail,
        format,
        refresh,
        noSubtitle,
        chunkSeconds: null,
        model: null,
        output: output.trim() || null
      }
      await window.btv.task.submit(params)
      setUrl('')
      onSubmitted()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <h1 className="text-2xl font-bold text-slate-900">新建任务</h1>
      <div className="space-y-2">
        <label className="text-sm font-medium text-slate-700">视频链接 / BV 号</label>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="BV... 或 https://www.bilibili.com/video/BV..."
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none"
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <label className="text-sm font-medium text-slate-700">详细程度</label>
          <select
            value={detail}
            onChange={(e) => setDetail(e.target.value as 'brief' | 'normal' | 'deep')}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          >
            <option value="brief">简要</option>
            <option value="normal">标准</option>
            <option value="deep">深度</option>
          </select>
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium text-slate-700">输出格式</label>
          <select
            value={format}
            onChange={(e) => setFormat(e.target.value as 'md' | 'json')}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          >
            <option value="md">Markdown</option>
            <option value="json">JSON</option>
          </select>
        </div>
      </div>
      <div className="space-y-2">
        <label className="text-sm font-medium text-slate-700">输出路径（可选）</label>
        <input
          value={output}
          onChange={(e) => setOutput(e.target.value)}
          placeholder="留空则使用默认 out/标题/"
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
      </div>
      <div className="flex gap-6 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={noSubtitle} onChange={(e) => setNoSubtitle(e.target.checked)} />
          跳过字幕，强制音频转写
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={refresh} onChange={(e) => setRefresh(e.target.checked)} />
          忽略缓存重新获取
        </label>
      </div>
      {error && <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      <button
        onClick={() => void submit()}
        disabled={submitting}
        className="rounded-md bg-slate-900 px-5 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
      >
        {submitting ? '提交中...' : '提交任务'}
      </button>
    </div>
  )
}

function TasksPage({ tasks, onChange }: { tasks: TaskRecord[]; onChange: () => void }): JSX.Element {
  const [selected, setSelected] = useState<string | null>(null)
  const active = tasks.find((t) => t.id === selected) ?? tasks[0] ?? null

  return (
    <div className="flex h-full gap-4">
      <div className="w-80 space-y-2 overflow-auto">
        <h1 className="text-2xl font-bold text-slate-900">任务列表</h1>
        {tasks.length === 0 && <p className="text-sm text-slate-500">暂无任务</p>}
        {tasks.map((t) => (
          <button
            key={t.id}
            onClick={() => setSelected(t.id)}
            className={`block w-full rounded-md border p-3 text-left text-sm ${
              active?.id === t.id ? 'border-slate-900 bg-white' : 'border-slate-200 bg-white hover:border-slate-400'
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="font-medium text-slate-900">{t.title}</span>
              <StateBadge state={t.state} />
            </div>
            <div className="mt-1 text-xs text-slate-500">{t.bvid}</div>
            {t.progress && (
              <div className="mt-2">
                <div className="h-1.5 w-full overflow-hidden rounded bg-slate-100">
                  <div
                    className="h-full bg-slate-700 transition-all"
                    style={{ width: `${Math.round((t.progress.done / Math.max(1, t.progress.total)) * 100)}%` }}
                  />
                </div>
                <div className="mt-1 truncate text-xs text-slate-500">{t.progress.message}</div>
              </div>
            )}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-auto rounded-md bg-white p-4 ring-1 ring-slate-200">
        {active ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-slate-900">{active.title}</h2>
              <StateBadge state={active.state} />
            </div>
            <div className="text-xs text-slate-500">{active.bvid} · 创建于 {new Date(active.createdAt).toLocaleString()}</div>
            {active.progress && (
              <div className="rounded-md bg-slate-50 p-3 text-sm">
                <div className="font-medium text-slate-700">{active.progress.phase}</div>
                <div className="mt-1 text-slate-600">{active.progress.message}</div>
              </div>
            )}
            {active.error && <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{active.error}</div>}
            {active.outputPath && (
              <div className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-800">
                输出：{active.outputPath}
                <button
                  onClick={() => void window.btv.output.open(active.outputPath!)}
                  className="ml-3 underline"
                >
                  打开目录
                </button>
              </div>
            )}
            <div className="flex gap-2 pt-2">
              {(active.state === 'queued' || active.state === 'running') && (
                <button
                  onClick={() => { void window.btv.task.cancel(active.id); onChange() }}
                  className="rounded-md bg-red-600 px-4 py-1.5 text-sm text-white hover:bg-red-500"
                >
                  取消
                </button>
              )}
              {(active.state === 'interrupted' || active.state === 'error' || active.state === 'cancelled') && (
                <button
                  onClick={() => { void window.btv.task.resume(active.id); onChange() }}
                  className="rounded-md bg-slate-900 px-4 py-1.5 text-sm text-white hover:bg-slate-700"
                >
                  续跑
                </button>
              )}
            </div>
          </div>
        ) : (
          <p className="text-sm text-slate-500">选择左侧任务查看详情</p>
        )}
      </div>
    </div>
  )
}

function StateBadge({ state }: { state: string }): JSX.Element {
  const color =
    state === 'done'
      ? 'bg-emerald-100 text-emerald-700'
      : state === 'running'
        ? 'bg-blue-100 text-blue-700'
        : state === 'error'
          ? 'bg-red-100 text-red-700'
          : state === 'cancelled' || state === 'interrupted'
            ? 'bg-slate-200 text-slate-600'
            : 'bg-amber-100 text-amber-700'
  return <span className={`rounded px-2 py-0.5 text-xs ${color}`}>{STATE_LABEL[state] ?? state}</span>
}

function HistoryPage(): JSX.Element {
  const [items, setItems] = useState<any[]>([])
  const [md, setMd] = useState<string>('')
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => {
    void window.btv.output.listHistory().then(setItems)
  }, [])

  useEffect(() => {
    if (!selected) return
    void window.btv.output.readMarkdown(selected).then(setMd)
  }, [selected])

  return (
    <div className="flex h-full gap-4">
      <div className="w-80 space-y-2 overflow-auto">
        <h1 className="text-2xl font-bold text-slate-900">历史结果</h1>
        {items.length === 0 && <p className="text-sm text-slate-500">暂无历史输出</p>}
        {items.map((it) => (
          <button
            key={it.dir}
            onClick={() => setSelected(it.summaryPath)}
            className={`block w-full rounded-md border p-3 text-left text-sm ${
              selected === it.summaryPath ? 'border-slate-900 bg-white' : 'border-slate-200 bg-white hover:border-slate-400'
            }`}
          >
            <div className="font-medium text-slate-900">{it.title}</div>
            <div className="text-xs text-slate-500">{it.bvid}</div>
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-auto rounded-md bg-white p-5 ring-1 ring-slate-200">
        {selected ? (
          <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">{md || '（空）'}</pre>
        ) : (
          <p className="text-sm text-slate-500">选择左侧历史查看 Markdown</p>
        )}
        {selected && (
          <button
            onClick={() => void window.btv.output.open(selected)}
            className="mt-4 rounded-md bg-slate-900 px-4 py-1.5 text-sm text-white hover:bg-slate-700"
          >
            打开输出目录
          </button>
        )}
      </div>
    </div>
  )
}

function SettingsPage(): JSX.Element {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [masked, setMasked] = useState<AppConfig | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void window.btv.config.get().then((c) => { setConfig(c); setMasked(c) })
    void window.btv.config.masked().then(setMasked)
  }, [])

  if (!config || !masked) return <p className="text-sm text-slate-500">加载中...</p>

  async function update(key: string, value: string): Promise<void> {
    await window.btv.config.set(key, value)
    const c = await window.btv.config.get()
    setConfig(c)
    setMasked(await window.btv.config.masked())
    setSaved(true)
    setTimeout(() => setSaved(false), 1200)
  }

  const fields: { key: string; label: string; value: string; secret?: boolean }[] = [
    { key: 'bilibili.sessdata', label: 'B 站 SESSDATA（可粘贴完整 Cookie）', value: masked.bilibili.sessdata, secret: true },
    { key: 'llm.base_url', label: 'LLM Base URL', value: config.llm.base_url },
    { key: 'llm.api_key', label: 'LLM API Key', value: masked.llm.api_key, secret: true },
    { key: 'llm.model', label: 'LLM 模型', value: config.llm.model },
    { key: 'llm.temperature', label: 'Temperature', value: String(config.llm.temperature) },
    { key: 'llm.max_retries', label: '最大重试次数', value: String(config.llm.max_retries) },
    { key: 'asr.language', label: 'ASR 语言（留空自动）', value: config.asr.language },
    { key: 'cloud_asr.base_url', label: '云端 ASR Base URL', value: config.cloud_asr.base_url },
    { key: 'cloud_asr.api_key', label: '云端 ASR API Key', value: masked.cloud_asr.api_key, secret: true },
    { key: 'cloud_asr.model', label: '云端 ASR 模型', value: config.cloud_asr.model },
    { key: 'concurrency.videos', label: '并发视频数', value: String(config.concurrency.videos) },
    { key: 'concurrency.llm', label: '全局在途 LLM 请求', value: String(config.concurrency.llm) },
    { key: 'concurrency.asr', label: '并发 ASR 上传', value: String(config.concurrency.asr) }
  ]

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <h1 className="text-2xl font-bold text-slate-900">设置</h1>
      {saved && <div className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">已保存</div>}
      <div className="space-y-4">
        {fields.map((f) => (
          <div key={f.key} className="space-y-1">
            <label className="text-sm font-medium text-slate-700">{f.label}</label>
            <input
              type={f.secret ? 'password' : 'text'}
              // 密钥字段不回显打码值：避免失焦时把 **** 当成新密钥写回
              defaultValue={f.secret ? '' : f.value}
              placeholder={f.secret ? (f.value ? `${f.value}（留空表示不修改）` : '未配置') : undefined}
              onBlur={(e) => {
                const value = e.target.value
                if (f.secret) {
                  if (!value.trim()) return
                  e.target.value = ''
                  void update(f.key, value)
                  return
                }
                if (value === f.value) return
                void update(f.key, value)
              }}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none"
            />
          </div>
        ))}
      </div>
    </div>
  )
}

function CostPage(): JSX.Element {
  const [agg, setAgg] = useState<any>(null)

  const reload = useCallback(() => {
    void window.btv.usage.aggregate().then(setAgg)
  }, [])

  useEffect(() => { reload() }, [reload])

  if (!agg) return <p className="text-sm text-slate-500">加载中...</p>

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">成本统计</h1>
        <button
          onClick={() => { if (confirm('确认清空所有成本明细？')) void window.btv.usage.reset().then(reload) }}
          className="rounded-md bg-red-600 px-4 py-1.5 text-sm text-white hover:bg-red-500"
        >
          清空明细
        </button>
      </div>
      <div className="rounded-md bg-white p-4 ring-1 ring-slate-200">
        <div className="text-sm text-slate-500">累计任务</div>
        <div className="text-3xl font-bold text-slate-900">{agg.count}</div>
        <div className="mt-2 text-sm text-slate-500">累计金额</div>
        <div className="text-2xl font-bold text-slate-900">¥ {Number(agg.grandTotal).toFixed(6)}</div>
      </div>

      <div className="rounded-md bg-white p-4 ring-1 ring-slate-200">
        <h2 className="mb-3 font-bold text-slate-900">LLM</h2>
        <table className="w-full text-sm">
          <thead className="text-left text-slate-500">
            <tr><th className="pb-2">模型</th><th className="pb-2">调用</th><th className="pb-2">输入 token</th><th className="pb-2">输出 token</th><th className="pb-2">金额</th></tr>
          </thead>
          <tbody>
            {Object.entries(agg.llm as Record<string, any>).map(([model, v]) => (
              <tr key={model} className="border-t border-slate-100">
                <td className="py-2">{model}</td><td>{v.calls}</td><td>{v.prompt_tokens}</td><td>{v.completion_tokens}</td><td>¥ {Number(v.cost).toFixed(6)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="rounded-md bg-white p-4 ring-1 ring-slate-200">
        <h2 className="mb-3 font-bold text-slate-900">ASR</h2>
        <table className="w-full text-sm">
          <thead className="text-left text-slate-500">
            <tr><th className="pb-2">模型</th><th className="pb-2">秒数</th><th className="pb-2">金额</th></tr>
          </thead>
          <tbody>
            {Object.entries(agg.asr as Record<string, any>).map(([model, v]) => (
              <tr key={model} className="border-t border-slate-100">
                <td className="py-2">{model}</td><td>{Number(v.seconds).toFixed(1)}</td><td>¥ {Number(v.cost).toFixed(6)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {agg.unknown.length > 0 && (
        <div className="rounded-md bg-amber-50 p-4 text-sm text-amber-800">
          <div className="font-medium">未配置单价的模型（金额计 0）</div>
          <ul className="mt-1 list-inside list-disc">
            {agg.unknown.map((u: any, i: number) => (
              <li key={i}>{u.kind}: {u.model}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
