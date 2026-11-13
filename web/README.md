# Web 依赖

Web 使用 [agegr/pi-web](https://github.com/agegr/pi-web) `0.16.0`，源码固定到发布标签 `v0.16.0` 对应的提交 `97e411f3c7433088937ce6ba18039439658f5e6e`。上游已将八个 Pi 系列依赖（含 `pi-schema`）统一锁定为 `1.5.2`，与主项目一致，无需额外版本补丁。

## 构建与运行

```sh
bun run prepare:web
bun run test:web
bun run check:web
```

`prepare:web` 校验本目录源码包 `pi-web-<commit>.tar.gz` 的 SHA-256，解压到 `.cache/pi-web`，应用 `pi-web-bun.patch`，再按本目录的 `bun.lock` 冻结安装依赖。源码包随仓库保存，构建时无需访问 GitHub；安装 npm 依赖仍需联网。

- `test:web`：执行补丁测试，覆盖会话来源与只读视图、终端触控与输入、主题切换及访问边界。真实 Pi/tmux 用例验证消息块换色、草稿和进程保留，运行环境需提供 tmux。
- `build:web`：补丁测试通过后，生成 Next.js 生产构建；生产服务由 Bun 启动。
- `check:web`：执行生产构建（含补丁测试）和 Web smoke；CI 在相关路径发生变更时运行此命令。

补丁测试按 `components/Workbot*.test.mjs`、`lib/workbot-*.test.mjs` 自动发现，每个文件使用独立 Bun 进程，隔离模块 mock、DOM 和 SDK 缓存，不继承主项目的测试目录、preload 或业务凭证。组件使用真实 React 的 `createRoot` / `act` 和 Happy DOM，不模拟 hooks；终端输入与渲染仍由真实浏览器验收补充。保留上游源码和格式，不为了统一主项目风格而大范围修改补丁。

Workbot 通过 `src/chat/web.ts` 管理 Web 进程，操作方式见 [使用说明](../docs/使用.md#按需使用-web)。两套运行镜像均设置 `SHELL=/bin/bash`，让内置终端使用支持宽字符行编辑的 Bash，而不是 `/bin/sh`（dash）；否则汉字可能已删除，但回显只擦掉一列而留下残字。Web smoke 验证 Bash 启动；`test/fixtures/tui-input-browser.mjs` 另用真实 Bash PTY 和 xterm 屏幕验证候选汉字删除后的内容及光标位置。

## 补丁内容

`pi-web-bun.patch` 中的 Bun 适配来源于 [brynne8/pi-web-bun](https://github.com/brynne8/pi-web-bun)：

| 来源提交                                   | 应用内容                    |
| ------------------------------------------ | --------------------------- |
| `77f81ec694da06fbe22d149241af915e6adf637e` | Bun 原生 PTY 和终端后端选择 |
| `4e591fe020d3ed94723f3125a64b25091b50317d` | SDK / MCP 包解析            |
| `52c8d75e0e8e7b6b628edd61210324ef311d1045` | npm / npx 调用改用 Bun      |

Workbot 自身的补丁包括：

- **IM 来源识别**：根据首条 `workbot.origin` 自定义条目及其绑定的 Pi session ID 识别来源，覆盖首屏摘要、完整列表和详情，不依赖文件路径、标题或消息正文。IM 会话仅供查看，并提示用户回到对应渠道回复；独立 TUI 启动接口拒绝启动 IM 会话，通用会话 API 的访问权限不变。Web 自建会话不受此限制，分叉会话不继承原会话的 IM 归属。
- **会话视图切换**：打开已保存的普通 Web 会话时，先静默检查 TUI 状态，完成必要的记录刷新后，再挂载 GUI 聊天区或 TUI 只读记录视图，避免界面闪烁。检查失败时提供重试入口，不提前挂载聊天区。只读记录复用普通 GUI 聊天的字号样式作用域，跟随设置中的聊天内容字号变化。
- 通过内部变量 `PI_WEB_DEFAULT_CWD` 将工作区作为 Web 默认目录，值来自 `WORKBOT_WORKSPACE`。
- 增加独立 TUI 的启动、状态和代理认证入口；启动前释放空闲 SDK，依据 tmux 状态使用 `WorkbotTranscript` 显示只读记录。上游 0.14 已将 `SubagentViewer` 替换为可交互的 `SessionChatPanel`；本地从 0.13 的 MIT 源码保留精简的只读分页逻辑，复用新版 `MessageView`，只读取 context API，不启动 AgentSession 或连接 Agent SSE。独立页面复用 Pi Web 的终端外观和移动端组件，通过 ttyd 连接 tmux，触摸与输入法适配见 [独立终端依赖](../terminal/README.md)。独立 TUI 与内置 `TerminalPanel` 共用输入法兼容层：候选栏输入通过可取消的 `beforeinput` 提交，避免 xterm 的按键状态漏收延迟确认的文本；输入框内组合输入仍交由 xterm 处理，终端销毁时清理兼容层。内置终端在触屏设备上不自动聚焦，避免首次挂载先聚焦只读输入框、连接后已有焦点却无法唤起键盘；由用户轻点终端触发原生聚焦，桌面端仍在可输入后自动聚焦。验收需在手机浏览器中分别检查首次新建、刷新恢复和切换终端标签后的轻点输入，不以桌面触屏模拟代替软键盘实测。
- **终端主题**：内置终端与独立 TUI 共用 `lib/workbot-terminal-theme.ts`，连接后切换主题时同步页面配色与 Pi 自动主题。Pi 固定主题沿用 `/settings` 中的选择。
- 限定上游 tsconfig 的 Node / React 环境类型。
- 将 Google Fonts 改为 `fonts/NotoSansMono.woff2` 本地字体，构建时不再下载字体。字体来自 [google/fonts](https://github.com/google/fonts/tree/097bc1b8c04c3224087c2ae95f7a923859b778cf/ofl/notosansmono)，由 FontTools 4.62.1 转为 WOFF2，许可证见 [fonts/OFL.txt](fonts/OFL.txt)。

## 更新依赖

1. 更新 `src/runtime/paths.ts` 中的 `WEB_COMMIT`，从 `https://codeload.github.com/agegr/pi-web/tar.gz/<commit>` 下载原始源码，替换本目录的 `pi-web-<commit>.tar.gz` 及同名 `.sha256` 校验文件（在本目录执行 `shasum -a 256 pi-web-<commit>.tar.gz > pi-web-<commit>.tar.gz.sha256`）。
2. 核对并更新补丁、Pi 依赖版本和本目录的锁文件。
3. 执行 `bun run check:web`，检查补丁测试、生产构建和 Web smoke；更新 Web、Pi 或终端适配时另跑 `bun run check:tui`，验证会话事件和启动兼容性。新增补丁测试沿用上述命名模式即可接入执行入口，不单独维护文件清单。

源码采用 MIT 许可，版权和许可见本目录 [LICENSE](LICENSE) 及源码包中的 LICENSE。
