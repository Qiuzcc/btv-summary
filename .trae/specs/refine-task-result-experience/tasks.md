# Tasks

- [x] Task 1: 实现历史任务删除的主进程能力与 IPC 白名单
  - [x] 在 TaskManager 中增加删除方法，仅允许删除 `done`、`error`、`cancelled`、`interrupted`，活动任务明确拒绝，删除后持久化并发送状态/列表更新事件
  - [x] 在共享 API 契约、preload 与主进程 IPC 中增加对应的 `task.remove` 通道，保持渲染层无 Node/Electron 直接访问
  - [x] 增加 Vitest：覆盖四种可删状态、活动状态拒绝、删除后列表及 `tasks.json` 持久化、删除不影响输出/缓存/用量文件

- [x] Task 2: 完成提交后跳转与运行中动画
  - [x] 新建任务仅在 `task.submit` 成功后切换到「任务列表」并刷新数据，失败仍停留原页显示错误
  - [x] 为 `running` 状态增加轻量动画，其他状态不显示运行动画；保持 Hooks 调用顺序稳定
  - [x] 验证提交成功/失败分支及运行到终态时的动画切换

- [x] Task 3: 在任务列表接入历史任务删除交互
  - [x] 对四种历史状态显示「删除」按钮，活动任务不显示或禁用；点击后进行确认
  - [x] 调用 `task.remove` 后刷新列表并修正当前选中任务；失败时展示错误，取消确认时不调用 IPC
  - [x] 验证删除后界面、刷新及重启持久化一致，输出目录与成本统计不受影响

- [x] Task 4: 将结果页原文展示替换为内置 Markdown 预览
  - [x] 引入本地 Markdown/GFM 渲染依赖，替换 `<pre>`，完成标题、列表、引用、代码块、表格等适合桌面阅读的排版
  - [x] 默认禁用原始 HTML，过滤危险链接，不引入在线渲染服务
  - [x] 处理加载、空内容和切换结果时的状态，保留打开输出目录按钮
  - [x] 使用包含标题、列表、引用、代码块、表格及恶意 HTML 的样本验证预览与安全性

- [x] Task 5: 执行回归验证
  - [x] 运行相关 Vitest、全量 `pnpm test`、`pnpm typecheck` 与 `pnpm build`
  - [x] 走查四条用户流程：成功/失败提交、运行动画、历史删除与持久化、Markdown 预览
  - [x] 核查 Electron 安全基线、五页面可达性及原有取消/续跑/打开目录功能无回归

# Task Dependencies
- Task 1 与 Task 2 可并行实施。
- Task 3 依赖 Task 1 和 Task 2。
- Task 4 依赖 Task 2；与 Task 3 均修改 `App.tsx`，为避免冲突按顺序实施。
- Task 5 依赖 Task 1–4。
