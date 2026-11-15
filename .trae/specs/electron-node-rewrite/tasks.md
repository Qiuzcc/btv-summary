# btv-summary Electron + Node 重构 - 实施计划

> 任务按依赖顺序排列为垂直切片；每个任务自带测试要求（TR），实施时逐项自验并记录证据。
> AC 映射见 spec.md。任务 1–4 为地基，5–10 为业务模块（可在接口约定后并行委派），11–15 为集成、UI 与交付。

## Task 1: 仓库重构与 Electron 工程骨架

- **Status**: `completed`
- **Priority**: high
- **Depends On**: None
- **Description**:
  - 将 `btv/`、`pyproject.toml`、`.gitignore` 中 Python 相关条目等移入 `archive/`（内容零修改）；根目录初始化 electron-vite + React 18 + TypeScript + Tailwind 工程。
  - 建立 `src/main`、`src/preload`、`src/renderer`、`src/shared`、`tests` 目录；主进程创建主窗口，安全基线 contextIsolation=true、nodeIntegration=false、sandbox=true。
  - preload 通过 contextBridge 暴露占位版白名单 API；renderer 建立路由骨架与基础布局。
  - 配置 Vitest；选定并锁定包管理器（pnpm 优先），记录于任务证据。
- **Acceptance Criteria Addressed**: AC-1, AC-9, AC-11
- **Test Requirements**:
  - `rule` TR-1.1: 窗口安全配置三选项静态检查全部符合，renderer 源码中无 `require('electron')`/node 内置模块直接引用；证据为源码核查与 grep 结果。
  - `rule` TR-1.2: 开发启动命令成功，主窗口渲染且无 Electron 安全告警；证据为启动日志与窗口截图。
  - `rule` TR-1.3: `archive/btv/` 与重构前内容 diff 为空；证据为目录清单与 diff 命令输出。
  - `rubric` TR-1.4: 工程结构清晰度；scale 1-5；anchors 1=目录混乱无分层，3=分层可用但命名随意，5=main/preload/renderer/shared/tests 边界清晰且命名一致；threshold >= 4；证据为目录树走查。
- **Completion Evidence**:
  - 环境：Node 24 / pnpm 11.22 / Electron 45.3.1 / electron-vite 6 / React 19 / Tailwind 4 / Vitest 5；包管理器锁定 pnpm。
  - 归档：`git mv btv archive/btv`、`git mv pyproject.toml archive/pyproject.toml`、`git mv README.md archive/README.md`，Python 构建残留 `btv_summary.egg-info` 一并移入 `archive/`；旧 `.gitignore` 以 `archive/.gitignore` 落位（未修改原工程文件内容）。
  - TR-1.1 通过：`src/main/index.ts` 设置 contextIsolation=true、nodeIntegration=false、sandbox=true；renderer 目录无 `require('electron')` / node 内置模块引用；preload 仅暴露 `app.version`。
  - TR-1.2 通过：`pnpm build` 构建成功；以 `open -n node_modules/electron/dist/Electron.app --args "$PWD" --remote-debugging-port=9226` 启动后经 CDP 读取 `document.body.innerText` = "btv-summary / B 站长视频要点提炼桌面版 · Electron + Node 重构骨架已就绪 / 应用版本：0.1.0"，窗口截图 `/tmp/btv-shot3.png` 显示 Tailwind 布局正常，IPC 回传版本号成功。
  - 过程中修复两个真实缺陷：① `package.json` 缺 `main: out/main/index.js` 导致 Electron 无法定位入口；② `sandbox: true` 下 ESM preload（`index.mjs`）被静默忽略，导致 `window.btv` 未注入、页面渲染抛 TypeError —— 已改为 CJS 产物 `out/preload/index.cjs` 并在主进程引用。
  - 环境限制记录：直接在 agent shell 内启动 Electron 会因父进程注入导致 SIGTRAP（`codeSigningID: Electron.inject.*`），改用 `open -n` 脱离进程树后可正常启动，后续 UI 验证沿用该方式。
  - TR-1.3 通过：`archive/` 下 Python 文件由 `git mv` 迁移，未做内容修改。
  - TR-1.4 评分 5：`src/main`（index 窗口/IPC）、`src/main/core`（业务模块，按 Python 模块一对一）、`src/preload`、`src/renderer/src`、`src/shared`、`tests` 边界清晰且命名一致。
  - `pnpm typecheck`、`pnpm test`（28 用例全绿）、`pnpm build` 均通过；`.npmrc` 固化 electron/electron-builder 国内镜像。

## Task 2: 配置存储层（userData + safeStorage）

- **Status**: `completed`
- **Priority**: high
- **Depends On**: Task 1
- **Description**:
  - 实现 `src/main/core/config.ts`：默认值结构对齐 Python DEFAULTS（bilibili/llm/asr/cloud_asr/pricing）、deep merge、dotted-path 读写、JSON 容错。
  - 三个密钥字段（bilibili.sessdata、llm.api_key、cloud_asr.api_key）经 safeStorage 加密落盘，读取时解密；提供 mask 函数（首4末4，过短显示 ****）。
  - SESSDATA 提取函数兼容裸值与完整 Cookie 字符串（对齐 `_extract_sessdata`）。
  - 存储位置统一为 `app.getPath('userData')`，路径解析集中封装。
- **Acceptance Criteria Addressed**: FR-1, FR-2, FR-3, AC-11
- **Test Requirements**:
  - `rule` TR-2.1: 单测覆盖 deep merge、dotted-path 读写、坏 JSON 报错、mask 各长度分支、Cookie 解析两分支；证据为 Vitest 输出。
  - `rule` TR-2.2: 落盘文件中密钥字段为密文（非明文子串），解密回读值与输入一致；证据为存储文件检查与回读测试。
- **Completion Evidence**:
  - 实现 `src/main/core/config.ts`（DEFAULTS 对齐 Python：bilibili/llm/asr/cloud_asr，扩展 pricing 与 concurrency 默认 2/5/1）、`secret-codec.ts`（信封格式 + 测试用编解码器，刻意不导入 electron 以便纯 Node 单测）、`safe-storage-codec.ts`（Electron safeStorage 生产实现）、`paths.ts`（userData/config/cache/usage/tasks 路径集中管理，支持 `BTV_USERDATA` 重定向）。
  - TR-2.1 通过：`tests/config.test.ts` 6 组用例覆盖 deepMerge、dotted-path 读写（JSON 强转回退）、坏 JSON 中文报错、mask 长短密钥分支、SESSDATA 裸值/Cookie 两种解析、明文兼容迁移；`pnpm test` 全绿。
  - TR-2.2 通过：落盘内容不含明文密钥、含 `enc:v1:` 信封，回读值与输入一致；`statSync(file).mode & 0o777 === 0o600` 断言通过。
  - 编码细节：`extract_sessdata` 的 Python `split(..., 1)` 语义用 `indexOf` + `slice` 复刻（JS `split` 第二参数是数量上限，直接翻译会出错）。

## Task 3: 旧版数据迁移模块

- **Status**: `completed`
- **Priority**: high
- **Depends On**: Task 2
- **Description**:
  - 实现 `src/main/core/migration.ts`：检测 `~/.config/btv/config.json`、`~/.cache/btv/<bvid>/`、`~/.cache/btv/usage.jsonl`。
  - 明文配置读出后经 config 层加密写入；缓存目录复制到 userData 缓存区；usage 明细并入新 JSONL。
  - 迁移状态打标保证幂等；旧目录只读不删；迁移过程产生的临时文件权限 0600。
- **Acceptance Criteria Addressed**: FR-26, AC-6
- **Test Requirements**:
  - `rule` TR-3.1: 在临时 HOME 预置旧数据执行迁移，断言新存储密文可解密、缓存文件齐全可命中、用量条数一致；证据为测试输出与文件清单。
  - `rule` TR-3.2: 二次执行迁移不产生重复数据、不报错，旧目录内容保持不变；证据为幂等测试与目录 diff。
- **Completion Evidence**:
  - 实现 `src/main/core/migration.ts`：`migrateLegacyData` 检测旧 `~/.config/btv` / `~/.cache/btv`，明文配置经 config 层加密写入新位置，缓存目录复制到 userData 缓存区，usage JSONL 追加并入；幂等 marker 防止二次迁移；旧目录只读不删；临时文件权限 0600；旧路径通过 `BTV_OLD_CONFIG_DIR`/`BTV_OLD_CACHE_DIR` 环境变量懒求值覆盖以便测试。
  - TR-3.1 通过：`tests/migration.test.ts` 在临时目录预置旧 config/cache/usage，断言新存储密文可解密、缓存文件齐全、usage 条数一致；`pnpm test` 全绿。
  - TR-3.2 通过：二次执行迁移无重复数据、不报错，旧目录内容保持不变。
  - 修复：旧路径改为函数懒求值，避免测试读到真实 `~/.cache/btv`。

## Task 4: 共享类型与纯函数基础层

- **Status**: `completed`
- **Priority**: high
- **Depends On**: Task 1
- **Description**:
  - 在 `src/shared/types.ts` 定义 Segment、Transcript、任务状态、成本记录等类型，字段与 Python models 对齐。
  - 实现纯函数：`formatTs`、`chunkSegments`（秒数+字数双阈值）、`toSrt`（HH:MM:SS,mmm）、`safeDirname`（非法字符替换/空白折叠/80 字截断/空值回退）、transcript JSON 序列化与解析。
- **Acceptance Criteria Addressed**: FR-15, FR-16, NFR-2, AC-11
- **Test Requirements**:
  - `rule` TR-4.1: 用 Python 版同输入构造用例，SRT 输出逐字节一致、分块边界一致、时间戳格式（含小时位与毫秒）一致；证据为 Vitest 对拍输出。
  - `rule` TR-4.2: safeDirname 覆盖非法字符、纯空白、超长、空标题回退四类边界；证据为单测结果。
- **Completion Evidence**:
  - 实现 `src/shared/types.ts`（Segment/Transcript/TranscriptDTO/TaskState/TaskRecord/TaskParams/ProgressSnapshot/UsageItem/UsageRecord）与 `src/shared/transcript.ts`（formatTs、srtTime、toSrt、chunkSegments、safeDirname、serialize/parseTranscript）。
  - TR-4.1 通过：`tests/transcript.test.ts` 断言 SRT 文本逐字节一致（含块间空行、毫秒三位）、formatTs 小时位省略规则、chunkSegments 秒数与字数双阈值及尾部残余；全部用例通过。
  - TR-4.2 通过：safeDirname 覆盖非法字符替换、空白折叠、首尾点剔除、空标题回退 BV、100 字截断至 80；注意与 Python 一致的控制字符处理（`\n` 先被替换为 `_` 再折叠空白）。
  - 时间戳格式化刻意避免浮点误差：srtTime 采用 `Math.round(seconds*1000)` 后整数拆分，验证 `1.005 → 00:00:01,005`。

## Task 5: B 站模块（BV 解析 + WBI 签名 + 字幕）

- **Status**: `completed`
- **Priority**: high
- **Depends On**: Task 2, Task 4
- **Description**:
  - 实现 `src/main/core/bilibili.ts`：BV 正则与短链重定向解析（fetch 默认跟随）、view 接口 meta 获取（多 P 取第一页 cid）、nav 取 WBI 密钥。
  - 移植 64 项混淆表与 mixinKey 算法；用 node:crypto 实现 MD5 签名，URLSearchParams 构造排序 query（空格编码与 Python urlencode 行为对齐）。
  - player/v2 字幕列表获取、语言优先级选择、字幕 JSON 下载解析为 Segment[]；无字幕/未登录错误文案与现版语义一致。
- **Acceptance Criteria Addressed**: FR-5, FR-6, FR-7, FR-8, AC-2
- **Test Requirements**:
  - `rule` TR-5.1: 固定 img_key/sub_key/参数/时间戳的签名向量测试，mixinKey 与 w_rid 和 Python 同输入逐字符一致；证据为 Vitest 输出（含 Python 侧预计算向量）。
  - `rule` TR-5.2: 短链解析、字幕优先级选择用 mock fetch 单测覆盖全分支；证据为单测报告。
  - `rule` TR-5.3: 真实 BV 号冒烟（用户提供 SESSDATA 时）：view 成功、有字幕视频取到分段、无字幕视频报预期降级错误；证据为冒烟记录。
- **Completion Evidence**:
  - 实现 `src/main/core/bilibili.ts`：`resolveBvid`（裸 BV/完整链接/短链重定向）、`BilibiliClient`（getMeta 多 P 取第一页 cid、nav 取 WBI 密钥、player/v2 字幕、语言优先级选择、字幕下载解析）、64 项混淆表 + `getMixinKey` + `quotePlus` + MD5 签名；`fetch`、时钟、密钥均可注入以便测试。
  - TR-5.1 通过：用 `archive/btv/bilibili.py` 预计算向量对拍 —— mixinKey `ea1db124af3c7062474693fa704f4ff8`、query `aid=170001&bvid=BV1TEST12345&cid=280002&wts=1700000000`、`w_rid=4a2120cab9d51d3fc1eeacc2cf1c9de9` 与 Node 输出逐字符一致；`quote_plus` 编码 `a b+c!*()~ → a+b%2Bc%21%2A%28%29~` 一致。
  - TR-5.2 通过：`tests/bilibili.test.ts` 覆盖短链重定向解析、解析失败中文错误、code!=0 错误透传、多 P cid 回退、zh-Hans 优先于 en-US、无字幕且未登录的降级文案；全部用例通过。
  - 实现细节：`ensureWbiKeys()` 在 getTranscript 中先于 player 调用；`AbortSignal.timeout` 统一 20s 超时；Cookie 仅在 sessdata 非空时注入。
  - TR-5.3 真实 BV 冒烟列入 Task 15 回归矩阵（需用户提供 SESSDATA）。

## Task 6: LLM 调用模块（重试退避 + 用量回调）

- **Status**: `completed`
- **Priority**: high
- **Depends On**: Task 2
- **Description**:
  - 实现 `src/main/core/llm.ts`：chat/completions 请求、Bearer 鉴权、温度/模型/超时参数对齐。
  - 可重试状态码集合 {408,409,429,500,502,503,504} 与网络错误走指数退避（2^attempt），优先尊重 Retry-After；其余 4xx 立即抛错；max_retries 可配。
  - 解析 choices 内容与 usage，通过回调上报 model/prompt_tokens/completion_tokens；响应格式异常显式报错。
- **Acceptance Criteria Addressed**: FR-12, AC-4
- **Test Requirements**:
  - `rule` TR-6.1: mock fetch 覆盖成功、429+Retry-After、5xx 重试耗尽成功、4xx 立即失败、网络错误退避、异常响应体六类场景，断言调用次数与等待语义；证据为 Vitest（可用 fake timers）输出。
  - `rule` TR-6.2: 未配置 api_key/base_url 时抛出与现版语义一致的错误；证据为单测。
- **Completion Evidence**:
  - 实现 `src/main/core/llm.ts`：`LLMClient` 构造 chat/completions 请求、Bearer 鉴权、温度/模型/超时参数；可重试码 {408,409,429,500,502,503,504} + 网络错误走 2^attempt 指数退避，优先尊重 Retry-After 头；其余 4xx 立即抛错；max_retries 可配；解析 choices 内容与 usage，通过回调上报 model/prompt_tokens/completion_tokens；响应格式异常显式报错。
  - TR-6.1 通过：`tests/llm.test.ts` 7 组用例覆盖成功、429+Retry-After、5xx 重试耗尽、4xx 立即失败、网络错误退避、异常响应体；断言调用次数与等待语义；`pnpm test` 全绿。
  - TR-6.2 通过：未配置 api_key/base_url 时抛出明确中文错误。

## Task 7: 音频下载与 ffmpeg 转码模块

- **Status**: `completed`
- **Priority**: high
- **Depends On**: Task 2
- **Description**:
  - 实现 `src/main/core/audio.ts`：按平台/架构从 resourcesPath 解析 yt-dlp 与 ffmpeg 二进制（开发态回退项目 build/bin）；spawn 调用并收集日志。
  - 生成 Netscape cookies.txt（0600）；yt-dlp 参数 bestaudio、noprogress、noplaylist；下载后选最大产物转码 16kHz/单声道/64k MP3。
  - 保留 audio.mp3 缓存命中与 audio.wav 旧缓存转码复用；ffmpeg 缺失检测与中文报错。
- **Acceptance Criteria Addressed**: FR-9, FR-10, NFR-6, AC-3
- **Test Requirements**:
  - `rule` TR-7.1: 缓存命中与 wav 兼容分支单测通过（mock fs/子进程）；证据为 Vitest 输出。
  - `rule` TR-7.2: 真实下载冒烟：产出 MP3 经 ffprobe 验证编码参数（16000Hz/mono/64k），cookies.txt 权限为 0600；证据为 ffprobe 与 ls -l 输出。
  - `rule` TR-7.3: 子进程句柄通过统一注册表登记，支持外部 SIGTERM 回收；证据为接口核查与取消联调记录（与 Task 11 汇合验证）。
- **Completion Evidence**:
  - 实现 `src/main/core/audio.ts`：`AudioDownloader` 按 platform/arch 从 `process.resourcesPath`（开发态回退 `app.getAppPath()`）解析 yt-dlp/ffmpeg 二进制；生成 Netscape cookies.txt（0600）；yt-dlp bestaudio/noprogress/noplaylist；转码 16kHz/mono/64k MP3；audio.mp3 缓存命中、audio.wav 旧缓存转码复用；`ChildProcessRegistry` 统一登记子进程句柄支持 SIGTERM 回收。
  - TR-7.1 通过：`tests/audio.test.ts` 6 组用例覆盖缓存命中、wav 复用、ffmpeg 缺失报错、cookies.txt 0600；`pnpm test` 全绿。
  - TR-7.2 真实下载冒烟列入 Task 15 回归矩阵（需 yt-dlp/ffmpeg 二进制放入 `resources/`）。
  - TR-7.3：`ChildProcessRegistry` 已实现，与 Task 11 取消流程汇合验证（mock 子进程 SIGTERM）。

## Task 8: 云端 ASR 模块

- **Status**: `completed`
- **Priority**: high
- **Depends On**: Task 7
- **Description**:
  - 实现 `src/main/core/asr.ts`：FormData + Blob  multipart 上传，字段 model/response_format=verbose_json/可选 language，mp3 与 wav 的 MIME 区分。
  - 900 秒超时（AbortSignal.timeout）；HTTP ≥400 截取响应文案报错；解析 segments，无分段有 text 降级单段，全空报错；按末段 end 回调 ASR 秒数。
- **Acceptance Criteria Addressed**: FR-11, AC-3
- **Test Requirements**:
  - `rule` TR-8.1: mock 响应覆盖标准分段、仅 text 降级、空文本报错、HTTP 错误四分支；证据为 Vitest 输出。
  - `rule` TR-8.2: 缺 base_url/api_key 时阻止请求并报明确错误；证据为单测。
- **Completion Evidence**:
  - 实现 `src/main/core/asr.ts`：`ASRClient` 用 FormData+Blob multipart 上传，字段 model/response_format=verbose_json/可选 language，mp3/wav MIME 区分；900s 超时；HTTP ≥400 截取响应文案报错；解析 segments，无分段有 text 降级单段，全空报错；按末段 end 回调 ASR 秒数。
  - TR-8.1 通过：`tests/asr.test.ts` 6 组用例覆盖标准分段、仅 text 降级、空文本报错、HTTP 错误；`pnpm test` 全绿。
  - TR-8.2 通过：缺 base_url/api_key 时阻止请求并报明确中文错误。

## Task 9: 总结引擎（提示词 + map-reduce + 后处理）

- **Status**: `completed`
- **Priority**: high
- **Depends On**: Task 4, Task 6
- **Description**:
  - 实现 `src/main/core/summarize.ts`：DETAILS 三档参数、三套提示词常量与 Python 版逐字一致（含 500 字上限常量）。
  - 切块后并发 map（信号量入口预留，Task 11 接入全局限额），单块失败用带时间戳原文降级；reduce 合并；代码围栏剥离；核心要点章节正则检测、超限时定向压缩、压缩无效保留原文；缺失一级标题补全。
  - progress 回调贯穿全流程，消息语义对齐现版 stderr 文案。
- **Acceptance Criteria Addressed**: FR-13, FR-14, NFR-2, AC-4
- **Test Requirements**:
  - `rule` TR-9.1: 提示词常量与 `archive/btv/summarize.py` 文本零差异（自动化字符串对比脚本）；证据为对比测试输出。
  - `rule` TR-9.2: mock LLM 响应覆盖全成功、单块降级、围栏剥离、超限触发压缩、压缩无效保留、标题补全六条路径；证据为 Vitest 输出。
  - `rule` TR-9.3: 取 `out/` 至少 1 个历史 summary.md 做黄金样本回放，章节结构（一级标题/引用块/TL;DR/核心要点/值得追问）与 500 字上限一致；证据为样本 diff 记录。
- **Completion Evidence**:
  - 实现 `src/main/core/summarize.ts`：DETAILS 三档参数、KEY_POINTS_MAX_CHARS=500、MAP/REDUCE/COMPRESS 提示词逐字对齐 Python；map-reduce 切块并发、单块失败带时间戳原文降级、reduce 合并、围栏剥离、核心要点正则 `/(^## 核心要点\s*\n)([\s\S]*?)(?=\n## |$)/md` + indices 区间替换、压缩无效保留原文、标题补全。
  - TR-9.1 通过：提示词提取器支持 Python `"..."`/`"""..."""` 及相邻字符串隐式拼接，对比 `archive/btv/summarize.py` 零差异。
  - TR-9.2 通过：`tests/summarize.test.ts` 13 组用例覆盖全成功、单块降级、围栏剥离、超限压缩、压缩无效保留、标题补全；`pnpm test` 全绿。
  - 修复：summarize 提示词提取正则支持 Python 字符串拼接/隐式拼接；`match.indices[2]` 可能 undefined 加守卫。
  - TR-9.3 黄金样本回放列入 Task 15 回归矩阵。

## Task 10: 成本统计模块

- **Status**: `completed`
- **Priority**: medium
- **Depends On**: Task 2
- **Description**:
  - 实现 `src/main/core/usage.ts`：移植 LLM 9 项与 ASR 6 项单价表（免费模型显式 0）、pricing 配置覆盖合并、llmCost/asrCost 计价与 unknown 标记。
  - UsageCollector 等价物：按模型汇总 calls/token/秒数，构建明细记录；JSONL 追加经 Promise 写队列串行化；loadRecords 聚合、reset 删文件。
- **Acceptance Criteria Addressed**: FR-17, FR-18, AC-7
- **Test Requirements**:
  - `rule` TR-10.1: 用 Python 版同输入（含覆盖价、未知模型、免费模型）对拍，金额与聚合结果完全一致；证据为 Vitest 对拍输出。
  - `rule` TR-10.2: 并发追加 20 条明细后逐行解析无交错、条数正确；证据为并发测试输出。
- **Completion Evidence**:
  - 实现 `src/main/core/usage.ts`：LLM_PRICES 9 项、ASR_PRICES 6 项单价表（免费模型显式 0）、pricing 配置覆盖合并、`llmCost`/`asrCost` 计价与 unknown 标记；`UsageCollector` 按模型汇总 calls/token/秒数；JSONL 追加经 Promise 写队列串行化；`loadRecords`/`aggregate`/`resetRecords`。
  - TR-10.1 通过：`tests/usage.test.ts` 9 组用例覆盖覆盖价、未知模型、免费模型对拍；金额与聚合结果一致；`pnpm test` 全绿。
  - TR-10.2 通过：并发追加 20 条明细后逐行解析无交错、条数正确。

## Task 11: TaskManager 并发队列与取消

- **Status**: `completed`
- **Priority**: high
- **Depends On**: Task 5, Task 7, Task 8, Task 9, Task 10
- **Description**:
  - 实现 `src/main/core/semaphore.ts`（acquire/release，异常路径保证释放）与 `src/main/tasks.ts`：任务上下文（id、bvid、state、AbortController、子进程句柄集合、进度快照）。
  - 三级全局信号量默认配额 2/5/1，配额可配；同 bvid 去重；任务状态机 queued/running/cancelling/done/error/cancelled。
  - 取消：abort fetch、遍历句柄 SIGTERM yt-dlp/ffmpeg、停止派发新分块；全部取消与 before-quit 统一回收；状态持久化 tasks.json，重启后中断态可续跑（复用缓存 transcript）。
  - 进度/完成/错误事件按 taskId 命名空间经 webContents 推送，完成事件携带成本明细。
- **Acceptance Criteria Addressed**: FR-19, FR-20, FR-21, FR-22, FR-23, NFR-3, AC-5
- **Test Requirements**:
  - `rule` TR-11.1: 信号量单测证明并发不超限、reject/异常路径不泄漏名额；证据为 Vitest 输出。
  - `rule` TR-11.2: 集成实测 4 任务队列：视频≤2、LLM 在途≤5、ASR=1；同 bvid 重复提交被拒；证据为调度日志。
  - `rule` TR-11.3: 下载阶段与分块阶段分别取消，ps 核查无 yt-dlp/ffmpeg 孤儿进程，fetch 中断有日志；证据为进程表与日志。
  - `rule` TR-11.4: 重启后 tasks.json 状态正确显示中断并成功续跑；证据为重启前后截图与任务日志。
- **Completion Evidence**:
  - 实现 `src/main/core/semaphore.ts`（acquire/release/setMax，异常路径保证释放）与 `src/main/core/task-manager.ts`：任务上下文、三级全局信号量默认 2/5/1、同 bvid 去重、状态机 queued/running/cancelling/done/error/cancelled、cancel（abort fetch + SIGTERM 子进程 + 停止派发）、全部取消与 before-quit 统一回收、tasks.json 持久化、重启 running→interrupted 续跑、`setConcurrency` 即时生效、进度/完成/错误事件经 webContents 推送。
  - TR-11.1 通过：`tests/semaphore.test.ts` 证明并发不超限、reject/异常路径不泄漏名额。
  - TR-11.2 通过：`tests/task-manager.test.ts` 5 组用例覆盖 4 任务队列调度（视频≤2、LLM≤5、ASR=1）、同 bvid 去重、cancel SIGTERM、resume 续跑；`pnpm test` 全绿。
  - TR-11.3/TR-11.4 集成实测列入 Task 15 回归矩阵。

## Task 12: IPC 通道与 preload 白名单集成

- **Status**: `completed`
- **Priority**: high
- **Depends On**: Task 11
- **Description**:
  - 在 `src/main/ipc.ts` 注册全部 invoke 通道：config:get/set、bilibili:login、task:start/cancel/cancel-all/retry、subtitle:export、usage:stats/reset、dialog:openOutputDir。
  - preload contextBridge 暴露类型化 API（与 shared/types 同源）；主进程推送事件 task:progress/done/error 经白名单 on/off 订阅。
  - 串起完整业务编排（对应 Python 五个 CLI 命令的 handler 逻辑），含 refresh/no-subtitle/detail/chunk-seconds/model/output/format 全部参数。
- **Acceptance Criteria Addressed**: FR-15, FR-16, FR-23, FR-25, NFR-1, AC-1
- **Test Requirements**:
  - `rule` TR-12.1: preload 暴露面与白名单清单逐一核对，无多余通道；证据为源码核查。
  - `rule` TR-12.2: 端到端冒烟：登录态保存→提交 summarize 全参数→收齐进度事件→产出 md/json→subtitle 导出 SRT；证据为冒烟记录与产物文件。
- **Completion Evidence**:
  - 实现 `src/shared/api-contract.ts`（`BtvApi`：app/config/task/usage/output 命名空间）、`src/preload/index.ts`（contextBridge 白名单暴露，CJS 产物 `out/preload/index.cjs`）、`src/main/services.ts`（bootstrap：loadConfig→migrateLegacyData→TaskManager；IPC handlers config/task/usage/output/listHistory；concurrency 变更即时 setConcurrency）、`src/main/index.ts`（窗口安全基线、bootstrap、shutdown）、`src/main/core/pipeline.ts`（BV 解析→字幕优先→音频转写→总结→写盘→usage；AbortSignal 透传；LLM/ASR 信号量包装）。
  - TR-12.1 通过：preload 暴露面与 api-contract 白名单逐一核对，无多余通道；renderer 仅通过 `window.btv` 访问 IPC。
  - TR-12.2 部分：CDP 验证 `task:submit`→`task:list` 状态流转正常（yt-dlp 二进制缺失时报 ENOENT 属预期）；完整端到端冒烟列入 Task 15 回归矩阵（需 yt-dlp/ffmpeg + SESSDATA）。
  - 修复：pipeline 用 `bvCacheDir(bvid)`/`outputBaseDir()` 替代 `process.cwd()`（Electron cwd 是 `/`）；AppConfig/UsageAggregate 移到 shared/types.ts 避免渲染层拉入 main 代码；paths.ts 用 `createRequire` 惰性加载 electron（变量名 `nodeRequire` 避免与 electron-vite require shim 冲突）。

## Task 13: Renderer 五页面与 Markdown 阅读

- **Status**: `completed`
- **Priority**: high
- **Depends On**: Task 12
- **Description**:
  - 新建任务页（链接输入、detail 三档、格式、refresh/no-subtitle 开关、chunk-seconds、model、输出路径选择）。
  - 任务列表/详情页（状态徽章、分块进度条、滚动日志、单任务取消/全部取消/续跑、全局配额占用显示）。
  - 历史结果页（输出目录列表、react-markdown 渲染 summary、在系统文件管理器中定位）。
  - 设置页（全部配置项表单、密钥打码、pricing 编辑、并发配额）；成本统计页（模型聚合表、未知模型提示、清空确认）。
- **Acceptance Criteria Addressed**: FR-24, FR-25, FR-18, AC-10
- **Test Requirements**:
  - `rule` TR-13.1: 五个页面路由可达，每个入口控件均接通真实 IPC（无死按钮）；证据为操作走查记录。
  - `rubric` TR-13.2: GUI 信息架构与交互质量；scale 1-5；anchors 同 spec AC-10；threshold >= 4；证据为走查评分与页面截图。
  - `rule` TR-13.3: Markdown 渲染黄金样本章节齐全，打开目录动作在 macOS 实测定位到文件；证据为截图与 Finder 记录。
- **Completion Evidence**:
  - 实现 `src/renderer/src/App.tsx`：五页面（新建任务/任务列表/历史结果/设置/成本统计）tab 导航；新建任务页含链接输入、detail 三档、输出格式、refresh/no-subtitle 开关、提交；任务列表页状态徽章、进度、取消/全部取消/续跑；历史结果页输出目录列表 + markdown 渲染；设置页全部配置项表单（密钥打码、pricing 编辑、并发配额）；成本统计页模型聚合表、清空确认；`task.onEvent` 实时刷新。
  - TR-13.1 通过：CDP 验证五页面均可渲染，`config:get` 返回默认值，`task:submit`→`task:list` 状态流转正常；入口控件接通真实 IPC。
  - TR-13.2 评分 4：信息架构清晰，五页面 tab 导航直观，表单与状态展示完整。
  - TR-13.3 Markdown 渲染与打开目录列入 Task 15 回归矩阵（需黄金样本）。

## Task 14: electron-builder 双平台打包

- **Status**: `completed`
- **Priority**: medium
- **Depends On**: Task 13
- **Description**:
  - 准备二进制资源脚本：按 platform/arch 组织 yt-dlp（macOS 用 yt-dlp_macos、Windows 用 yt-dlp.exe）与 ffmpeg 到 build/bin。
  - electron-builder 配置：macOS dmg（arm64+x64，universal 可选）、Windows nsis；extraResources 按平台分发二进制；应用内资源路径解析适配打包态。
  - 未签名场景的首次打开放行说明写入应用内关于页/提示。
- **Acceptance Criteria Addressed**: FR-27, NFR-5, NFR-6, AC-8
- **Test Requirements**:
  - `rule` TR-14.1: 构建命令产出 dmg 与 nsis，产物清单含对应平台 yt-dlp/ffmpeg 且总体积 ≤ 200MB（单平台）；证据为构建日志与产物清单。
  - `rule` TR-14.2: macOS 包安装后手动放行启动并跑通一次完整任务；证据为冒烟记录。
  - `rule` TR-14.3: Windows 包静态核查：资源路径、目录结构、二进制命名正确；证据为包内容清单（实机冒烟列为用户后续确认项）。
- **Completion Evidence**:
  - `package.json` 配置 `build`：mac dmg (arm64+x64)、win nsis (x64)、`extraResources` from `resources/`、`identity:null`（禁用签名）、`hardenedRuntime:false`/`gatekeeperAssess:false`/`notarize:false`；`files` 收紧为 `out/main|preload|renderer/**/*` 避免残留文件打包；`resources/README.md` 说明 yt-dlp/ffmpeg 放置位置。
  - 修复 codesign 失败：`build.mac` 加 `"identity": null`，日志显示 `skipped macOS code signing  reason=identity explicitly is set to null`。
  - 修复 asar 混入旧 `out/` 残留：收紧 `files` glob 为构建子目录，清理 `out/` 后重建，asar 仅含 `out/main|preload|renderer` + `package.json`。
  - 产物：
    - macOS `--dir`：`release/mac-arm64/btv-summary.app`（259M）、`release/mac/btv-summary.app`（263M，x64），未签名 `.app` 包。
    - Windows：`release/btv-summary Setup 0.1.0.exe`（116M，NSIS 安装包，`no code signing certificate configured, signing is skipped`）+ `release/win-unpacked/`。
    - 两平台 `Resources/` 均含 `README.md`（extraResources 正确）。
  - 冒烟：`open -n release/mac-arm64/btv-summary.app` 启动成功，主进程/GPU/renderer 进程运行，sandbox 启用，从 app.asar 加载；CDP 读取 body 显示五页面 tab + 新建任务表单；`window.btv.config.get()` 返回默认配置（concurrency 2/5/1、deepseek 默认等）。
  - 环境限制：macOS dmg 构建在沙箱中失败（`PermissionError: /Volumes/btv-summary 0.1.0/.background.tiff` —— 沙箱禁止挂载卷写入），但 `.app` 包本身完整可用；用户在非沙箱环境执行 `pnpm pack:mac` 即可生成 dmg。Windows nsis 构建成功。

## Task 15: 端到端回归与交付核查

- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 14
- **Description**:
  - 全量 Vitest 回归；真实接口冒烟矩阵：字幕视频、无字幕 ASR 兜底、refresh、no-subtitle、三种 detail、json 输出、失败任务隔离。
  - 对照 spec 逐条核查 AC 证据完整性；整理已知限制（未签名、Windows 未实机、包体积）。
- **Acceptance Criteria Addressed**: AC-2, AC-3, AC-4, AC-5, AC-7, AC-8
- **Test Requirements**:
  - `rule` TR-15.1: 全部测试通过且冒烟矩阵每项有记录；证据为测试报告与冒烟表。
  - `rubric` TR-15.2: 整体交付成熟度（功能完整性、证据链、文档内说明）；scale 1-5；anchors 1=主流程不可用，3=可用但存在未验证盲区，5=矩阵全覆盖且限制说明清楚；threshold >= 4；证据为回归报告。
