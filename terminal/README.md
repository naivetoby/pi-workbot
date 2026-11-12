# 独立终端依赖

用户操作和资源清理见 [使用说明](../docs/使用.md#独立-pi-tui)，进程与认证链路见 [技术架构](../docs/技术架构.md#按需-web)。

## 版本与构建

- ttyd 固定为 [tsl0922/ttyd@2922cb89f518bae4d0fcf4d757a7419638fc71fc](https://github.com/tsl0922/ttyd/tree/2922cb89f518bae4d0fcf4d757a7419638fc71fc)。本目录保存 GitHub 源码归档、SHA-256 和 MIT LICENSE，不修改上游源码。
- `Dockerfile` 构建 ttyd 后端；`prepare:tui` 复用固定 Pi Web 的 xterm、字体/主题设置、视口高度处理和触屏快捷键，构建独立页面，不再使用 ttyd 默认页面。页面通过 ttyd 原有 WebSocket 协议连接 tmux，保留 OSC 52 复制，不引入新的终端后端。
- Caddy、tmux 和 C 库使用基础镜像发行版软件包，要求 Caddy ≥2.6、tmux ≥3.3。终端依赖仅加入 chat 镜像。

## 适配边界

- `bin/workbot-tui-attach` 只接受固定长度的会话摘要，只能连接已有 tmux 会话，不能执行 URL 命令或创建 shell。
- `src/chat/tui-launch.ts` 从私有临时目录（0700）读取当前 Web 的环境快照（0600），删除文件后以 `execve` 替换为 Pi。环境不进入命令参数，不传 Web 密码，也不继承 tmux 服务中已过时或删除的变量；启动请求结束时清理临时目录。
- `src/chat/tui-session.ts` 仅通过此启动器的 `--extension` 加载，用 Pi 原生事件取消跨会话切换及分叉，确保 tmux 名称始终对应原会话。不维护会话映射，也不限制文件内树导航或修改工具集合。

`configs/tmux.conf` 使用专用 socket，不加载个人 tmux 配置；连接时强制 UTF-8，启用扩展键和 OSC 52。`Ms` 能力的目标固定为 `c`，避免空目标被浏览器剪贴板处理忽略。页面只接受剪贴板写入，不响应读取请求。

字号、字体、字重和明暗主题沿用同源 Pi Web 设置，顶部支持调整字号和主题。内置终端与独立 TUI 共用主题切换逻辑，Pi 的 `system`、`light/dark` 自动主题随之切换，固定主题沿用 `/settings` 中的选择。同一会话的 Pi 主题以最后一次切换为准。

移动端支持竖屏快捷键栏、键盘高度适配、单指纵向滚动和双指缩放；滚动历史由 Pi/tmux 管理。

独立 TUI 与 Pi Web 内置终端共用输入法兼容层：候选栏确认时，提前接收可取消、非组合态的 `beforeinput` 文本提交，阻止 textarea 再次变更，避免 xterm 漏收或重复发送。输入框内的 `composition*`、物理键、粘贴及删除继续使用 xterm 原生处理；不可取消或缺少文本的事件不接管，也不尝试回改已经发送到终端的自动纠错文本。

## 验证与更新

本地先安装 Caddy、tmux，并按 `Dockerfile` 从固定归档构建 ttyd：

```sh
bun run check:tui
# 可选：真实浏览器与剪贴板验收
WORKBOT_CHROME_BIN='/path/to/chrome' bun run smoke:tui --browser
# 独立输入与主题验收（需 Chrome、/bin/bash，先 prepare:web）
WORKBOT_CHROME_BIN='/path/to/chrome' bun test/fixtures/tui-input-browser.mjs
```

- `check:tui` 准备页面、构建 Web，再用临时配置和真实离线 Pi 验证认证、繁忙保护、固定会话（含扩展重载）、会话复用、重连、退出及 Web 重启后的环境更新，不连接模型或 IM。
- CI 的 `check-tui` 在相关 MR 和分支变更中执行 `docker build --target tui-check .`，使用实际 Linux 依赖运行同一 smoke，不安装角色插件或发布镜像。chat 镜像继承该验收层。
- 浏览器验收覆盖 GUI/TUI 交接、重连、字体与主题、剪贴板、触屏快捷键和视口适配。
- 独立输入与主题验收使用真实 xterm、Bash 和离线 Pi，覆盖两种终端的中日韩与 emoji 输入、删除重绘、消息块换色、刷新后切换及返回 Bash 后的正常输入。
- 手机实机验收覆盖 iOS 微信输入法、系统键盘和 Android 软键盘的候选输入、连续选词、删除与回车；浏览器权限及 Linux 部署另行验收。

升级 ttyd 时同步替换归档、校验文件和 `scripts/prepare-tui.ts` 中的提交值，确认前后端版本一致并执行上述检查，不直接跟随 main 或只更新后端。更新 Pi 或终端适配代码也需执行 TUI 验收；在线更新后退出现有 TUI 再打开，仅重启 Web 不会替换保活的 Pi。
