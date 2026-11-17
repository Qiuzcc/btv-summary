# 随包二进制

本目录放置随应用分发的外部二进制，打包时经 `extraResources` 复制到安装包的 Resources 目录，
主进程通过 `process.resourcesPath` 解析。

## 需要的文件

- `yt-dlp`（macOS）/ `yt-dlp.exe`（Windows）：yt-dlp 官方独立二进制
- `ffmpeg`（macOS）/ `ffmpeg.exe`（Windows）：ffmpeg 静态构建

当前 `ffmpeg` 为 9.0.2 通用二进制（arm64 + x86_64），使用 Martin Riedl 的同版本静态构建合并而成。下载与构建地址：<https://ffmpeg.martin-riedl.de/>。

## 放置规则

- macOS：直接放在 `resources/` 下（`resources/yt-dlp`、`resources/ffmpeg`），可执行权限 `chmod +x`。
- Windows：放在 `resources/` 下（`resources/yt-dlp.exe`、`resources/ffmpeg.exe`）。

主进程 `audio.ts` 的 `resolveBinaries()` 会按 `process.platform` 自动选择 `.exe` 后缀。应用只使用此目录中的随包二进制，不会回退到系统 PATH。
