# 应用图标

存放应用窗口图标与打包图标。使用时放入以下文件并在 `package.json` 的 `build` 配置中引用：

- `icon.ico` — Windows
- `icon.icns` — macOS
- `icon.png` — 通用 / Linux（建议 512×512）

当前仓库不含实际图标文件；未放图标时 electron-builder 会使用默认图标，不影响构建。
