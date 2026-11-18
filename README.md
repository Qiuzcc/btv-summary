# B 站视频总结

B 站长视频要点提炼桌面版：输入 BV 号，自动拉取字幕（无字幕则下载音频转写），再调用 LLM 生成 Markdown 总结。

## 下载

以下链接始终指向最新版本，点击即可下载：

- [macOS（Apple 芯片）](https://github.com/Qiuzcc/btv-summary/releases/latest/download/btv-summary-mac-arm64.dmg)
- [macOS（Intel）](https://github.com/Qiuzcc/btv-summary/releases/latest/download/btv-summary-mac-x64.dmg)
- [Windows（x64 安装程序）](https://github.com/Qiuzcc/btv-summary/releases/latest/download/btv-summary-win-x64-setup.exe)

历史版本见 [Releases 页面](https://github.com/Qiuzcc/btv-summary/releases)。

### macOS 首次打开提示

安装包未使用 Apple 开发者证书签名与公证（需付费账号），首次打开会被 Gatekeeper 拦截：

- 提示"Apple 无法检查其是否包含恶意软件"：打开 **系统设置 → 隐私与安全性**，在下方点"仍要打开"。
- macOS 14 及更早版本：右键应用图标 → 打开。
- 若提示"已损坏"：移除隔离属性后重试。

```bash
xattr -dr com.apple.quarantine "/Applications/B 站视频总结.app"
```

## 首次使用
【必填项】
首次启动后在设置中填写 LLM / ASR 接口与密钥。

推荐统一使用[硅基流动](https://cloud.siliconflow.cn)（也可以选择使用其它平台），一个账号、一个 Key 即可同时满足转写与总结：

1. 注册后到 [API 密钥](https://cloud.siliconflow.cn/account/ak) 页面创建以 `sk-` 开头的 Key。
2. **LLM**：`Base URL` 填 `https://api.siliconflow.cn/v1`，`模型` 填 `zai-org/GLM-5.3-Flash`（速度快、中文效果好、成本低）。
3. **云端 ASR**：`Base URL` 填 `https://api.siliconflow.cn/v1`，`模型` 填 `XingChenAGI/XingChenASR-Diarize-V3.0`（免费）。
4. 两处的 `API Key` 填同一个硅基流动 Key。

> 推荐选择能返回分段时间戳的 ASR 模型，这样长视频能按时间段分块总结。换成 `FunAudioLLM/SenseVoiceSmall`、`Qwen/Qwen3-ASR-1.7B` 等只返回整段文本的模型也能正常生成总结，只是退化为按字数切块。
> 也可替换为任意兼容 OpenAI 接口的服务：LLM 需支持 `/chat/completions`，云端 ASR 需支持 `/audio/transcriptions` 且 `Base URL` 以 `/v1` 结尾。

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

推送 `v*` 标签（如 `git tag v0.1.0 && git push origin v0.1.0`）会触发 GitHub Actions 自动构建 macOS / Windows 安装包并发布到 Releases，无需本地准备二进制。

## 说明

本项目仅作为演示目的，严禁作为商业用途。如有侵权，请联系@qiuzcc@qq.com进行相关处理。
