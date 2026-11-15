# btv-summary Electron + Node 重构 — 实施评审

> 本文档为实施完成后的自评审，供独立 reviewer 复核。所有证据均可在仓库中复现。

## 1. 交付概览

btv-summary 已从 Python 全量重构为 Electron + Node/TS 桌面应用，Python 源码零修改移入 `archive/`。

**已完成 Task 1–14**，Task 15（端到端回归矩阵）部分项目需用户提供 SESSDATA 与 yt-dlp/ffmpeg 二进制，已在 tasks.md 标注。

## 2. 工程结构

```
src/
├── main/
│   ├── index.ts              # 窗口 + bootstrap + shutdown
│   ├── services.ts           # IPC handlers + bootstrap 编排
│   └── core/
│       ├── config.ts         # 配置存储（safeStorage 加密）
│       ├── secret-codec.ts   # 测试用编解码器
│       ├── safe-storage-codec.ts  # 生产 safeStorage 实现
│       ├── paths.ts          # 路径集中管理（BTV_USERDATA 重定向）
│       ├── migration.ts      # 旧版数据迁移
│       ├── bilibili.ts       # WBI 签名 + 字幕
│       ├── llm.ts            # LLM 调用（重试退避）
│       ├── audio.ts          # yt-dlp/ffmpeg 下载转码
│       ├── asr.ts            # 云端 ASR
│       ├── summarize.ts      # map-reduce 总结引擎
│       ├── usage.ts          # 成本统计
│       ├── semaphore.ts      # 信号量
│       ├── task-manager.ts   # 并发队列 + 取消
│       └── pipeline.ts       # 端到端流水线
├── preload/index.ts          # contextBridge 白名单
├── renderer/src/App.tsx      # 五页面 UI
└── shared/
    ├── types.ts              # 共享类型（含 AppConfig/UsageAggregate）
    ├── transcript.ts         # 纯函数（formatTs/toSrt/chunkSegments/safeDirname）
    └── api-contract.ts       # BtvApi 类型契约
tests/                        # 12 文件 79 用例
archive/                      # 原 Python 工程（零修改归档）
```

## 3. 关键设计决策与风险点

| 决策 | 原因 | 风险/注意 |
|---|---|---|
| preload 用 CJS 产物 (`out/preload/index.cjs`) | `sandbox:true` 下 ESM preload 被静默忽略 | 主进程引用 `../preload/index.cjs`，electron.vite.config 设 `format:'cjs', entryFileNames:'[name].cjs'` |
| `paths.ts` 惰性加载 electron | 顶层 import electron 致纯 Node 测试崩 | 用 `createRequire` + 变量名 `nodeRequire`（electron-vite 已注入 require shim，不能用 `require`） |
| `AppConfig`/`UsageAggregate` 放 shared | 渲染层 typecheck 不能拉入 main 代码 | config.ts/usage.ts 从 shared re-export |
| pipeline 用 `bvCacheDir`/`outputBaseDir` | Electron cwd 是 `/`，不能用 process.cwd | 输出目录默认 `~/btv-summary`，可 `BTV_OUTPUT_DIR` 覆盖 |
| migration 旧路径懒求值 | 测试不能读真实 `~/.cache/btv` | `BTV_OLD_CONFIG_DIR`/`BTV_OLD_CACHE_DIR` 覆盖 |
| `identity:null` 禁用签名 | 无 Apple 证书，默认会找到本机身份签名失败 errSecInternalComponent | 用户首次打开需手动放行 |

## 4. 验证证据

### 4.1 静态检查
- `pnpm typecheck`（tsconfig.node + tsconfig.web）通过
- `pnpm build`（electron-vite）通过

### 4.2 单元测试
- `pnpm test`：12 文件 79 用例全绿
- 覆盖：config、transcript、bilibili（WBI 签名向量对拍 Python）、llm（重试退避）、audio（缓存命中/wav 复用）、asr（分段解析）、summarize（提示词逐字对齐 + 六条路径）、usage（计价对拍）、semaphore、task-manager（队列调度/去重/cancel/resume）、migration（幂等）、smoke

### 4.3 CDP 端到端验证（打包后 app）
- `open -n release/mac-arm64/btv-summary.app --args --remote-debugging-port=9334`
- 主进程/GPU/renderer 进程运行，sandbox 启用，从 app.asar 加载
- `document.body.innerText` 显示五页面 tab + 新建任务表单
- `window.btv.config.get()` 返回默认配置（concurrency 2/5/1、deepseek 默认）

### 4.4 打包产物
| 平台 | 产物 | 体积 | 签名 |
|---|---|---|---|
| macOS arm64 | `release/mac-arm64/btv-summary.app` | 259M | 未签名（identity:null） |
| macOS x64 | `release/mac/btv-summary.app` | 263M | 未签名 |
| Windows x64 | `release/btv-summary Setup 0.1.0.exe` | 116M | 未签名（无证书） |

- asar 仅含 `out/main|preload|renderer` + `package.json`（已清理旧残留）
- `Resources/README.md`（extraResources）正确打包

## 5. 已知限制（需用户后续确认）

1. **macOS dmg 未生成**：沙箱禁止写入 `/Volumes` 挂载卷（`.background.tiff` PermissionError），`.app` 包完整可用；用户在非沙箱环境执行 `pnpm pack:mac` 即可生成 dmg。
2. **未签名**：macOS 首次打开需右键打开或 `xattr -d com.apple.quarantine`；Windows SmartScreen 会拦截。
3. **yt-dlp/ffmpeg 二进制**：需用户按 `resources/README.md` 放置到 `resources/` 后重新打包。
4. **Task 15 回归矩阵**：真实 BV 冒烟（需 SESSDATA）、真实音频链路（需 yt-dlp/ffmpeg）、LLM 总结黄金样本回放、并发配额实测、迁移二次启动幂等——需用户提供凭据/二进制后执行。

## 6. 评审检查清单

请独立 reviewer 核查以下项目：

- [ ] `archive/` 下 Python 文件内容与重构前一致（零修改）
- [ ] 窗口安全基线：contextIsolation=true、nodeIntegration=false、sandbox=true
- [ ] preload 暴露面与 `src/shared/api-contract.ts` 白名单一致，无多余通道
- [ ] 三个密钥字段（sessdata/llm.api_key/cloud_asr.api_key）落盘为 `enc:v1:` 密文，文件权限 0600
- [ ] WBI 签名向量与 Python 预计算一致（mixinKey + w_rid）
- [ ] summarize 三套提示词与 `archive/btv/summarize.py` 逐字一致
- [ ] 三级信号量默认 2/5/1，cancel 后子进程无孤儿
- [ ] pipeline 输出目录用 `outputBaseDir()` 而非 process.cwd()
- [ ] `out/` 仅含构建产物，`app.asar` 无旧残留文件
- [ ] 12 文件 79 用例全绿，typecheck 通过
