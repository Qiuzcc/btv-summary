# B 站视频总结

B 站长视频要点提炼桌面版：输入 BV 号，自动拉取字幕（无字幕则下载音频转写），再调用 LLM 生成 Markdown 总结。

## 首次使用
【必填项】
首次启动后在设置中填写 LLM / ASR 接口与密钥。

【可选项】
- **SESSDATA**：支持粘贴完整 Cookie，会自动提取。
- **并发配额**：`videos`（同时处理的视频数）、`llm`（LLM 并发）、`asr`（转写并发），调整后即时生效。
- **LLM 模型参数**：`model`、`temperature`（采样温度）、`max_chars`（单次请求最大字符数）、`max_retries`（失败重试次数）。
- **ASR 语言**：`asr.language`，留空由服务自动识别。
- **云 ASR**：`cloud_asr.base_url` / `api_key` / `model`，视频无字幕时走云端转写。

## 开发

```bash
pnpm install
pnpm dev          # 启动开发环境
pnpm test         # 运行单元测试
pnpm typecheck    # 类型检查
```

## 打包

```bash
pnpm pack:mac     # 构建 macOS 安装包（dmg）
pnpm pack:win     # 构建 Windows 安装包（nsis）
pnpm pack:all     # 同时构建两个平台
```

打包前请确保 `resources/` 下存在对应平台的 `yt-dlp` 与 `ffmpeg` 二进制，详见 [resources/README.md](resources/README.md)。

## 说明

本项目仅作为演示目的，严禁作为商业用途。如有侵权，请联系@qiuzcc@qq.com进行相关处理。
