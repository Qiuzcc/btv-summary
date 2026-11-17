# 任务与结果页交互体验调整 Spec

## Why
当前提交任务后仍停留在新建页，运行状态缺少动态反馈，历史任务无法清理，结果页仅显示 Markdown 原文，影响任务跟踪与结果阅读体验。

## What Changes
- 新建任务提交成功后自动切换到「任务列表」，并展示刚提交任务的最新状态；提交失败时仍留在新建页显示错误。
- 「任务列表」的运行中状态增加清晰可见的动画反馈，任务进入终态后动画停止。
- 「任务列表」为已完成、失败、已取消、已中断的历史任务提供删除入口；删除前需确认，仅删除任务记录，不删除输出文件、转写缓存或成本明细。
- 「历史结果」页使用应用内置 Markdown 渲染器展示排版后的内容，替代 `<pre>` 原文显示；不依赖在线渲染服务，不执行 Markdown 中的原始 HTML/脚本。
- 无破坏性变更。

## Impact
- Affected specs: 新建任务交互、任务列表状态反馈、历史任务管理、Markdown 结果阅读。
- Affected code: `src/renderer/src/App.tsx`、`src/main/core/task-manager.ts`、`src/main/services.ts`、`src/preload/index.ts`、`src/shared/api-contract.ts`、`package.json`、相关 Vitest 测试。

## ADDED Requirements

### Requirement: 提交后进入任务列表
系统 SHALL 在新建任务成功提交后自动切换到「任务列表」页面，并刷新任务数据，使用户能立即看到新任务。

#### Scenario: 提交成功
- **WHEN** 用户填写有效任务参数并成功提交
- **THEN** 应用切换到「任务列表」，新任务出现在列表中，新建页不再保持当前展示状态

#### Scenario: 提交失败
- **WHEN** 任务提交因参数校验、重复任务或主进程错误而失败
- **THEN** 应用停留在「新建任务」页面并展示错误，不发生页面跳转

### Requirement: 运行状态动画
系统 SHALL 在任务列表及任务详情中为 `running` 状态提供持续、轻量的动画提示，并确保终态不保留运行动画。

#### Scenario: 任务运行中
- **WHEN** 任务状态为 `running`
- **THEN** 对应状态标识显示旋转或等效动画；若存在进度条，可附加不妨碍阅读的动态效果

#### Scenario: 任务离开运行状态
- **WHEN** 任务状态变为 `done`、`error`、`cancelled`、`interrupted` 或其他非运行状态
- **THEN** 运行动画停止且不再显示运行中的视觉提示

### Requirement: 删除历史任务记录
系统 SHALL 提供经 IPC 白名单暴露的历史任务删除能力，并在任务列表中提供删除按钮。只有 `done`、`error`、`cancelled`、`interrupted` 状态可删除；删除操作 SHALL 持久化到 `tasks.json`，且不得删除输出文件、缓存或成本明细。

#### Scenario: 删除历史任务
- **WHEN** 用户对可删除的历史任务点击「删除」并确认
- **THEN** 该任务从列表和持久化任务记录中移除，选中状态回退到剩余任务或空状态，刷新及重启后仍不出现

#### Scenario: 取消删除或删除失败
- **WHEN** 用户取消确认，或主进程删除失败
- **THEN** 任务记录保持不动；删除失败时页面显示明确错误

#### Scenario: 防止删除活动任务
- **WHEN** 任务处于 `queued`、`running` 或 `cancelling` 状态
- **THEN** 页面不提供可用删除入口，主进程也拒绝删除，避免绕过界面误删活动任务

### Requirement: Markdown 内置预览
系统 SHALL 在结果页内置 Markdown 渲染能力，将历史结果渲染为结构化排版，至少支持标题、段落、粗斜体、列表、引用、链接、行内代码、代码块及 GFM 表格。

#### Scenario: 预览历史结果
- **WHEN** 用户选择包含 `summary.md` 的历史结果
- **THEN** 页面显示渲染后的标题层级、列表、引用、代码与表格，而非 Markdown 原始标记，并保留「打开输出目录」能力

#### Scenario: 空内容或切换结果
- **WHEN** 文件为空、仍在加载或用户切换到另一结果
- **THEN** 页面展示对应空内容/加载状态，并显示当前选中文件的内容，不残留上一篇正文

#### Scenario: 不可信 Markdown
- **WHEN** Markdown 包含原始 HTML、脚本或危险链接
- **THEN** 渲染器不执行脚本、不启用原始 HTML，危险链接不形成可点击导航

## MODIFIED Requirements

### Requirement: GUI 信息架构与交互质量
任务提交、运行反馈、历史清理与结果阅读 SHALL 形成连续流程：提交后直接观察任务，运行状态清晰可见，历史任务可安全清理，结果以 Markdown 排版阅读；不得引入死按钮、白屏或违反 React Hooks 调用规则的实现。

## REMOVED Requirements

### Requirement: Markdown 原文展示
**Reason**: 原文展示可读性不足，且未满足结果预览需求。
**Migration**: 以本地 Markdown 渲染组件替换结果页 `<pre>` 展示，不改变已有 `summary.md` 文件内容与输出结构。
