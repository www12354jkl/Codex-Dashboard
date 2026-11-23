# Codex Dashboard HUD

面向 Windows 版 **Codex Desktop App** 的非侵入式透明悬浮指标条（Style A 原生融入风格），实时显示：

- **模型速度**：单步有效吞吐（`tok/s`，剔除工具执行耗时）、官方 TTFT、最近 7 步吞吐柱状图、模型 vs 工具耗时占比
- **上下文水位**：当前请求快照占模型有效窗口比例（正常钴蓝 `<60%` → 琥珀橙 `60–79%` → 警戒红 `≥80%`）、`80%` 自动压缩刻度线、压缩次数与释放量
- **Prompt 缓存命中率**：加权命中率（`Σcached_input_tokens / Σinput_tokens`）、命中/未命中/写入拆解、骤降预警
- **Token 消耗与配额**：会话累计消耗、已去重推理的输出拆解（`output = reasoning + visible`）、5h / 7d `rate_limits` 额度与重置倒计时
- **检查更新与安全覆盖更新**：支持 Git 源码快进更新（`--ff-only`）与 GitHub Release ZIP 校验覆盖更新，自动保留 `~/.codex-dashboard/config.json`

## 合规与安全边界

- **零改包 / 零注入**：不修改 Codex Desktop 安装文件、不解包 ASAR、不注入 DLL、不开远程调试端口
- **普通权限运行**：通过独立透明 Electron 浮窗 + Windows 只读 Win32/DWM/UIA 探测定位，配合坐标命中穿透仅对 5 颗按钮与当前展开的 Popover 响应点击，其余区域全穿透
- **防遮挡保护**：仅在 Codex 位于前台时显示；窗口最小化或弹出权限/审批对话框时自动隐藏
- **沙箱隔离**：渲染进程开启 `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false` 与严格 CSP

## 快速启动

环境要求：Node.js 22+（本机已验证 Node 24 + pnpm 11）、Windows 10/11。

提供两种并存模式，均**不修改 `app.asar`、不劫持账号请求**，所有指标均来自只读 `~/.codex/` 日志：

```powershell
# 安装依赖
pnpm install

# 模式 1（推荐 · 无黑框一键联动启停）：生成桌面 & 开始菜单快捷方式「Codex (Dashboard)」
# 双击该快捷方式（或右键固定到任务栏）即可无终端黑框拉起 Codex 并挂载仪表盘，彻底退出 Codex 后自动关闭
pnpm run shortcut

# 或直接从命令无黑框启动 CDP 托盘宿主（默认开启随 Codex 自动退出）
pnpm run start:cdp:bg

# 模式 2（终端前台运行 CDP 模式，适合开发调试，可加 -- --auto-exit）
# 若 Codex 当前已在运行但未开调试口，请先右键托盘彻底退出 Codex 再执行此命令
pnpm run start:cdp

# 模式 3（零端口透明浮窗）：自动吸附 Codex Desktop，未打开或不在前台时自动隐藏
pnpm start

# 独立预览模式（不追踪 Codex 窗口，便于直接调试浮窗样式与交互）
pnpm run dev

# 类型检查与自动化测试
pnpm run typecheck
pnpm test

# 只读联调本机 ~/.codex 会话日志（脱敏输出指标摘要）
pnpm run smoke:collector
```

## 位置微调与托盘控制

- 点击指标条最右侧的 **更新/设置图标** → 展开 **「浮窗对齐与外观设置」**，即可切换主题（系统 / 浅色 / 深色）、按 `4px` 步进微调 `X / Y` 偏移、以及开关「仅 Codex 前台显示 / 审批弹窗隐藏」。
- 所有用户配置独立保存在 `~/.codex-dashboard/config.json`，更新应用时不会被覆盖。
- 系统托盘图标支持右键切换：显示/隐藏浮窗、独立模式、检查更新、退出。

## 远程仓库与安全覆盖更新

插件内置固定更新仓库为 `www12354jkl/Codex-Dashboard`（`https://github.com/www12354jkl/Codex-Dashboard.git`）：

1. **Git 源码部署模式（默认）**：点击最右侧更新按钮 → **「检查更新」** 会自动 `git fetch` 比对上游；仅在本地工作树干净时允许安全 `--ff-only` 快进并自动重新构建，随后点击 **「热重载生效 / 立即重启生效」**。
2. **GitHub Release 打包模式**：发布带 `*.zip` 与对应 `.sha256` / `SHA256SUMS.txt` 的 GitHub Release 后，独立安装目录在应用更新前会强制校验 **SHA-256**、拒绝路径穿越与符号链接，并在退出后原子替换目录（失败自动回滚）。

## 目录结构

```text
shared/      共享 TypeScript 契约、IPC 通道常量与 mock 数据
ui/          Style A 原生融入前端（5 独立按钮 + 5 锚定 Popover + 透明浮窗模式）
cdp/         可选本机 CDP 模式（Shadow DOM 挂件、窄窗口独立小图标三档缩放、Chat 页自动隐藏、启动器）
collector/   ~/.codex Rollout JSONL 字节增量解析器与只读 SQLite 索引发现
overlay/     Electron 主进程、沙箱 preload、用户配置持久化与 Windows 60Hz 只读事件跟踪
updater/     Git / GitHub Release 检查与 SHA-256 校验原子替换更新器
tests/       Node 内置自动化单测（rollout 解析、配置原子写、更新安全校验、CDP 端到端）
preview/     设计定稿阶段保留的静态 HTML 交互原型（v1 / v2 / v3）
```
