# btv-summary Electron + Node 重构 - 产品需求文档

## Overview

- **Summary**: 将现有 Python 实现的 B 站长视频要点提炼工具（btv-summary）全量重构为 Electron + Node.js + TypeScript 桌面应用，Python 源码移入 `archive/` 留存；交付 macOS 与 Windows 双平台未签名安装包，内置多视频并发任务队列，并一次性迁移旧版本地数据。
- **Purpose**: 提供图形化操作界面，消除命令行使用门槛；以单语言（TypeScript）技术栈统一主进程业务逻辑与渲染层 UI；利用 Node 事件循环原生支持多任务并发，避免 Python sidecar 方案的双运行时与 IPC 协议成本。
- **Target Users**: 当前 CLI 的个人用户（内容创作者/研究者），需要在桌面端提交多个 B 站视频链接、观察进度、管理配置与成本、阅读 Markdown 笔记。

## Goals

- 在 Electron 主进程中用 TypeScript 等价重写全部 9 个 Python 模块的业务逻辑，行为与输出口径保持一致。
- 提供完整 GUI：任务提交、并发任务列表与实时进度、Markdown 结果阅读、配置管理、成本统计、字幕导出。
- 支持多视频并发：全局三级限流（视频数 / LLM 在途请求 / ASR 上传）、排队、按任务取消、断点续跑。
- 敏感凭据改用系统级加密存储（safeStorage），安全基线满足 Electron 官方推荐配置。
- 首次启动自动迁移旧版配置、转写缓存与成本明细，用户无需重新配置、不损失已付费转写成果。
- 产出 macOS（dmg）与 Windows（nsis）双平台未签名安装包，yt-dlp/ffmpeg 二进制随包分发。

## Non-Goals

- 不做代码签名、公证与自动更新（无 Apple Developer / Windows 代码签名证书；本期只产出未签名包与手动打开指引）。
- 不做 Linux 平台打包。
- 不保留 CLI 入口（Python 版归档后不再维护；Node 侧不额外提供命令行界面）。
- 不引入本地 HTTP/WebSocket 服务，进程间通信仅使用 Electron IPC。
- 不做云端同步、多用户账户体系、在线分享等网络服务功能。
- 不改变现有 LLM 提示词内容、Markdown 笔记结构与成本计价口径。

## Background & Context

- 现有代码位于 `btv/`（9 个模块：cli、config、models、bilibili、audio、asr、llm、summarize、usage），核心逻辑与 argparse 已基本解耦，`summarize()` 内置 progress 回调与 UsageCollector 成本钩子，可直接映射为 IPC 事件。
- 关键外部依赖：yt-dlp（Python 程序，使用官方 PyInstaller 独立二进制）、ffmpeg（ffmpeg-static 二进制）；两者在任何技术栈下都无法消除。
- B 站 player 接口需要 WBI 签名（64 项混淆表 + MD5），是重写中一致性风险最高的模块，需用已知向量单测固化。
- 已确认的用户决策：
  1. 根目录重构，Electron 工程占据仓库根目录，Python 代码移入 `archive/`；
  2. macOS + Windows 双平台打包（macOS 上交叉构建，不含签名公证）；
  3. 多视频并发队列纳入本期；
  4. 配置 + 转写缓存 + 用量明细全部迁移。
- 现有数据位置：`~/.config/btv/config.json`、`~/.cache/btv/<bvid>/`（audio.mp3、transcript.json）、`~/.cache/btv/usage.jsonl`；输出目录 `out/<安全化标题>/`。

## Functional Requirements

### 配置与凭据

- **FR-1**: 应用配置存储于 Electron `userData` 目录，配置结构与现有 DEFAULTS 完全对应（bilibili / llm / asr / cloud_asr / pricing），支持深度合并默认值与按点路径（dotted path）读写。
- **FR-2**: `bilibili.sessdata`、`llm.api_key`、`cloud_asr.api_key` 三个密钥字段经 `safeStorage.encryptString` 加密后落盘；界面展示时打码（保留首 4 末 4，过短显示 `****`），口径与现有 `masked()` 一致。
- **FR-3**: 支持粘贴完整 Cookie 字符串或裸 SESSDATA，解析逻辑与现有 `_extract_sessdata` 一致。
- **FR-4**: 支持在设置页查看/修改全部配置项，包括 pricing 单价覆盖（LLM 输入/输出单价、ASR 每秒单价）。

### 视频与字幕

- **FR-5**: 接受 BV 号、完整视频链接或 b23.tv 短链；短链跟随重定向后用同一 BV 正则解析，解析失败给出与现版等价的中文错误。
- **FR-6**: 调用 view 接口获取 aid/cid/标题/UP 主/时长，多 P 视频取第一页 cid。
- **FR-7**: 通过 nav 接口获取 WBI 密钥并完成 wbi 签名（wts 时间戳、参数排序、w_rid MD5），调用 player/v2 拉取字幕列表，按 `zh-Hans → zh-CN → ai-zh → zh → zh-Hant → 任意 zh 前缀 → 第一个可用` 的优先级选择，下载并解析为带时间戳的分段。
- **FR-8**: 无 SESSDATA 或字幕接口失败时，给出明确提示并自动降级到音频转写链路（与现版行为一致）。

### 音频与转写

- **FR-9**: 通过 spawn 随包 yt-dlp 二进制下载最佳音质音频，携带按 Netscape 格式生成的 cookies.txt（权限 0600）；下载前检测 ffmpeg 可用性，缺失时给出安装指引类错误。
- **FR-10**: 用随包 ffmpeg 转码为 16kHz、单声道、64kbps MP3；已存在 audio.mp3 时直接命中缓存；存在旧版 audio.wav 时先转码复用、不重新下载。
- **FR-11**: 云端 ASR 以 multipart/form-data 上传音频（model、response_format=verbose_json、可选 language），超时 900 秒；解析 segments 为分段，无分段但有 text 时降级为单段，无文本时报错；按最后一段结束时间记录 ASR 秒数。

### LLM 与总结

- **FR-12**: LLM 调用走 OpenAI 兼容 `/chat/completions`；对 408/409/429/500/502/503/504 与网络错误执行指数退避重试（默认 3 次，尊重 Retry-After 头），其余 4xx 立即失败；从响应提取真实 token 用量并回调记账。
- **FR-13**: 总结引擎保持现有 map-reduce 流程：按 detail（brief/normal/deep）对应的分块秒数与条数约束切块 → 分块并发提炼（单块重试耗尽则用带时间戳的原文降级，不中断整体）→ 合并生成固定结构 Markdown（标题、来源引用块、TL;DR、核心要点、值得追问）。
- **FR-14**: 三套提示词（MAP/REDUCE/COMPRESS）与全部后处理逻辑逐字搬运：剥离 Markdown 代码围栏、核心要点 500 字硬上限检测与定向 LLM 压缩（压缩失败或无效时保留原文）、缺失一级标题时补全。
- **FR-15**: 支持 `--refresh`（忽略缓存重取）、`--no-subtitle`（跳过字幕直接转写）、detail 三档、自定义 chunk-seconds、临时覆盖模型、md/json 两种输出格式、自定义输出路径；输出目录命名规则（非法字符替换、空白折叠、80 字截断、空标题回退 BV 号）与现版一致。
- **FR-16**: 字幕模式支持导出 SRT 与 transcript.json，SRT 时间戳格式（`HH:MM:SS,mmm`）与现版逐字节一致。

### 成本统计

- **FR-17**: 内置 LLM（9 个模型，输入/输出单价）与 ASR（6 个模型，每秒单价，含免费模型显式 0）参考单价表，支持配置 pricing 覆盖；每次任务结束追加一条 JSONL 明细，LLM 按真实 token × 单价、ASR 按秒数 × 单价计价，未配置单价的模型用量照记、金额计 0 并在统计页列出。
- **FR-18**: 统计页按模型聚合展示调用次数、token/秒数、金额与累计总额；支持一键清空明细。多任务并发结束时 JSONL 追加必须串行化，不得出现行交错。

### 多任务并发

- **FR-19**: 任务提交后进入队列，由全局信号量调度，默认配额：并发视频 2、全局在途 LLM 请求 5、并发 ASR 上传 1；配额可在设置页调整。
- **FR-20**: 同一 BV 号存在排队/运行中任务时拒绝重复提交（或明确提示复用），防止缓存文件写冲突。
- **FR-21**: 每个任务持有独立 AbortController 与子进程句柄集合；支持取消单个任务（中断在途 fetch、SIGTERM 终止 yt-dlp/ffmpeg、不再派发新分块）与全部取消；关闭窗口时统一回收，不得遗留孤儿进程。
- **FR-22**: 任务状态（queued/running/cancelling/done/error/cancelled）持久化到 userData；应用重启后未完成任务标记为「已中断」，可基于已缓存 transcript 一键续跑。
- **FR-23**: 进度事件按 taskId 命名空间推送（阶段、分块 x/y、消息），任务完成事件携带输出路径与本轮成本明细。

### GUI

- **FR-24**: 渲染层提供五个页面：新建任务（链接、detail、格式、开关项、输出路径）、任务列表/详情（状态徽章、进度条、日志、取消、续跑）、历史结果（输出目录浏览与 Markdown 阅读）、设置（全部配置项与并发配额）、成本统计（聚合表、未知模型提示、清空）。
- **FR-25**: Markdown 结果在应用内渲染阅读，支持打开输出目录（系统文件管理器定位文件）。

### 数据迁移与打包

- **FR-26**: 首次启动检测旧版 `~/.config/btv` 与 `~/.cache/btv`：明文配置读出后加密写入新存储、缓存目录整体复制到 userData 对应位置、usage.jsonl 明细并入新存储；迁移幂等（重复启动不重复迁移、不损坏数据），旧目录保留不删除。
- **FR-27**: electron-builder 产出 macOS dmg（arm64 与 x64）与 Windows nsis 安装包；yt-dlp、ffmpeg 按平台/架构经 extraResources 分发，主进程通过 resourcesPath 解析；无签名场景给出用户首次打开的手动放行说明。

## Non-Functional Requirements

- **NFR-1（安全）**: `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；渲染层仅通过 preload 的 contextBridge 白名单访问能力；不监听任何网络端口；cookies.txt 与迁移临时文件权限 0600。
- **NFR-2（一致性）**: 转写 JSON、SRT、Markdown 笔记结构、计价口径、错误文案语义与 Python 版保持一致；WBI 签名、分块、SRT、计价等纯函数具备与 Python 输出对拍的自动化测试。
- **NFR-3（可靠性）**: 长任务（ASR 最长 15 分钟）不阻塞 UI；单块/单任务失败被隔离，不拖垮其他任务；所有外部调用具备现版等价的超时与重试策略。
- **NFR-4（可维护性）**: main 进程按现有 Python 模块边界一对一组织 core 模块；提示词、单价表、WBI 混淆表等常量集中管理；核心纯函数由 Vitest 覆盖。
- **NFR-5（体积与启动）**: 安装包体积控制在 200MB 以内；冷启动到主窗口可交互 ≤ 5 秒（开发机基准）。
- **NFR-6（可移植性）**: 平台相关代码（路径、二进制名、打开目录）集中封装，业务模块不出现平台分支散落。

## Constraints

- **Technical**:
  - Electron（最新稳定线，≥ 30）+ electron-vite + electron-builder；Node 运行时 ≥ 20；渲染层 React 18 + TypeScript + Tailwind CSS；测试 Vitest。
  - 主进程全部业务逻辑 TypeScript 实现，不允许保留 Python 运行时依赖（yt-dlp 官方二进制除外，它是外部可执行文件而非项目源码依赖）。
  - 仅使用 Electron IPC 通信，不引入 HTTP 服务层。
- **Business**:
  - 本期无代码签名证书，仅交付未签名包。
  - 不改变提示词与输出格式，避免历史笔记风格漂移。
- **Dependencies**:
  - yt-dlp 官方独立二进制、ffmpeg-static（或等价随包 ffmpeg）；
  - B 站、LLM 服务商、云端 ASR 服务商的公开 HTTP 接口；
  - 网络可达性用于真实接口冒烟测试（测试环境需用户自备有效 API Key 与 SESSDATA）。

## Assumptions

- 用户本机具备 Node 20+ 与 npm/pnpm 开发环境；macOS 上交叉构建 Windows 包可行（electron-builder 官方支持，无需 Windows 机器）。
- 现有 `out/` 目录中的 summary.md 可作为黄金样本回归参照。
- safeStorage 在 macOS（Keychain）与 Windows（DPAPI）均可用；若个别 Linux 环境降级为明文加密密钥，不在本期处理范围。
- 音频下载与转写沿用现版参数（64kbps/16kHz/单声道），ASR 识别质量不受运行时更换影响。

## Acceptance Criteria

### AC-1: 工程骨架与 Electron 安全基线

- **Type**: `rule`
- **Given**: 仓库根目录已重构为 Electron 工程，Python 代码位于 `archive/btv/`
- **When**: 检查主进程窗口配置并执行开发启动
- **Then**: contextIsolation 为 true、nodeIntegration 为 false、sandbox 为 true；渲染层不存在直接的 Node/electron require；preload 仅暴露白名单 API；`npm run dev`（或 pnpm 等价命令）可启动应用并显示主窗口
- **Pass Condition**: 配置项静态检查全部符合，且开发模式应用成功启动无控制台安全告警
- **Evidence**: 主进程源码、preload 源码、启动命令输出与窗口截图

### AC-2: WBI 签名与 B 站接口行为等价

- **Type**: `rule`
- **Given**: 与 Python 版相同的 img_key/sub_key、请求参数与固定时间戳
- **When**: 运行签名模块单测并对真实 BV 号发起 view/player 请求
- **Then**: 产出的 mixin_key、排序后 query 与 w_rid 和 Python 版逐字符一致；真实接口返回 code=0 并能取得字幕或预期的降级错误
- **Pass Condition**: 签名向量单测全部通过，真实接口冒烟通过（含短链解析、字幕优先级选择）
- **Evidence**: Vitest 用例与输出、冒烟测试记录

### AC-3: 音频下载与转写链路等价

- **Type**: `rule`
- **Given**: 一个无字幕或强制 `no-subtitle` 的 BV 号与有效云端 ASR 配置
- **When**: 执行下载 → ffmpeg 转码 → ASR 上传全链路
- **Then**: 产出 16kHz/单声道/64kbps 的 audio.mp3；二次执行命中缓存不重复下载；旧 audio.wav 场景被转码复用；cookies.txt 权限为 0600；ASR 返回分段且按秒数记账；ffmpeg 缺失时给出明确错误
- **Pass Condition**: 各分支均有实测或测试证据，音频参数经 ffprobe 验证
- **Evidence**: 任务日志、ffprobe 输出、文件权限与缓存目录清单

### AC-4: LLM 重试与总结引擎输出等价

- **Type**: `rule`
- **Given**: mock fetch 模拟成功、429+Retry-After、5xx 重试耗尽、4xx 立即失败等响应，以及固定的转写输入
- **When**: 运行 LLM 模块与总结引擎单测，并对 `out/` 中至少 1 个历史样本做同输入回放
- **Then**: 重试次数、退避等待、错误抛出时机与 Python 版语义一致；三套提示词文本零差异；map-reduce、单块降级、代码围栏剥离、500 字压缩、标题补全行为与现版一致；回放产出的 Markdown 章节结构与黄金样本相同
- **Pass Condition**: 全部单测通过，黄金样本结构对比通过（标题、四个固定章节、时间戳列表、500 字上限）
- **Evidence**: Vitest 报告、黄金样本 diff 记录

### AC-5: 多任务并发调度与取消

- **Type**: `rule`
- **Given**: 队列中提交 4 个不同 BV 号任务（默认配额视频 2 / LLM 5 / ASR 1）
- **When**: 观察调度过程，在音频下载与分块阶段分别触发单任务取消与全部取消
- **Then**: 同时运行视频不超过 2、全局在途 LLM 不超过 5、ASR 同时只 1 个；同 BV 重复提交被拒绝；取消后对应 fetch 中断、yt-dlp/ffmpeg 子进程全部终止（进程表无残留）；usage.jsonl 无行交错；重启后任务状态正确显示为已中断且可续跑
- **Pass Condition**: 配额、去重、取消回收、持久化、续跑五项行为均有实测证据
- **Evidence**: 任务列表截图/日志、`ps` 进程核查、tasks.json 与 usage.jsonl 文件检查

### AC-6: 数据迁移正确且幂等

- **Type**: `rule`
- **Given**: 预置旧版 `~/.config/btv/config.json`（含明文密钥）、`~/.cache/btv/<bvid>/` 缓存与 usage.jsonl
- **When**: 首次启动应用后再次重启
- **Then**: 密钥在新存储中为密文且可被正确解密使用；缓存文件可被新任务命中；历史用量出现在统计页；第二次启动不重复迁移、数据不重复、旧目录保持原样
- **Pass Condition**: 两次启动后的存储检查与功能验证全部通过
- **Evidence**: 迁移日志、userData 文件检查、统计页截图、旧目录清单

### AC-7: 成本统计口径一致

- **Type**: `rule`
- **Given**: 与 Python 版相同的内置单价表、pricing 覆盖配置与一组构造的 usage 明细
- **When**: 运行计价单测并在统计页查看聚合
- **Then**: LLM/ASR 金额、未知模型标记（金额 0 且列出提示）、免费模型显式 0、聚合总额与 Python 版同输入结果完全一致；清空操作删除明细文件
- **Pass Condition**: 计价单测通过，页面数字与构造预期一致
- **Evidence**: Vitest 输出、统计页截图

### AC-8: 双平台打包产物可用

- **Type**: `rule`
- **Given**: 完成发布构建配置
- **When**: 在 macOS 上执行打包
- **Then**: 产出 macOS dmg（arm64/x64）与 Windows nsis 安装包；包内包含对应平台的 yt-dlp 与 ffmpeg 资源；macOS 包本机安装后可启动并跑通一次完整任务（手动放行 Gatekeeper）
- **Pass Condition**: 两类产物构建成功，macOS 安装包实机冒烟通过；Windows 产物至少完成静态内容核查（资源齐全、目录结构正确）
- **Evidence**: 构建日志、产物清单与大小、安装冒烟记录

### AC-9: Python 代码归档完整

- **Type**: `rule`
- **Given**: 重构完成后的仓库
- **When**: 检查目录结构与 Git 历史
- **Then**: `btv/`、`pyproject.toml` 等 Python 工程文件全部位于 `archive/` 下且内容未被修改；仓库根目录为 Electron 工程；归档代码仍可被测试与黄金样本对照引用
- **Pass Condition**: 目录核查通过，归档文件与重构前内容一致（diff 为空）
- **Evidence**: 目录列表、diff 核查

### AC-10: GUI 信息架构与交互质量

- **Type**: `rubric`
- **Dimension**: 界面可用性、状态可见性与操作效率
- **Scale**: 1-5
- **Anchors**: 1 = 功能入口缺失或状态不可见，无法独立完成任务；3 = 主流程可完成但进度/错误反馈薄弱、页面跳转混乱；5 = 五页面结构清晰，任务状态与进度实时可见，错误文案可操作，Markdown 阅读与输出目录定位便捷
- **Pass Threshold**: >= 4
- **Evidence**: 完整操作走查记录与各页面截图

### AC-11: 代码可维护性与模块对齐度

- **Type**: `rubric`
- **Dimension**: TypeScript 模块与原 Python 模块边界的对齐程度、常量集中度与测试覆盖
- **Scale**: 1-5
- **Anchors**: 1 = 逻辑散落、平台分支与业务耦合、无测试；3 = 主要模块可辨认但存在跨层耦合与少量未测纯函数；5 = core 目录与 Python 模块一对一清晰对应，提示词/单价/混淆表集中管理，纯函数均有 Vitest 覆盖且命名传达意图
- **Pass Threshold**: >= 4
- **Evidence**: 源码结构走查、测试覆盖率报告

## Open Questions

- 无阻塞性开放问题。以下事项在实施中按假设处理，若用户后续变更需求需回退本阶段：
  - [ ] 包管理器选择（倾向 pnpm，实施时以本机可用工具为准并在 tasks.md 记录）。
  - [ ] Windows 安装包无法在 macOS 实机运行验证，仅做静态核查，实机冒烟留待用户在 Windows 环境确认。
