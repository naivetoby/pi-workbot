# 独立部署

在服务器上从源码构建镜像，通过 Docker Compose 运行 chat，复用仓库中的模型配置、插件和运行入口，默认加载通用个人助手工作约定。默认自动启动带密码的 Web，并开启独立 Pi TUI；IM 和预拉取项目按需配置。

服务器需要 Linux amd64 环境、Git、Docker Engine 和 Docker Compose v2（支持 BuildKit 及 `up --wait`）。

## 启动与访问

```sh
git clone https://github.com/naivetoby/pi-workbot.git
cd pi-workbot/deploy
cp .env.example .env
# 设置 Web 密码和所用模型的 API Key；每项配置均有注释。
# 可用 openssl rand -hex 32 生成密码。
vi .env
docker compose up -d --build --wait --wait-timeout 420
```

首次启动会下载基础镜像、系统软件包和 npm 依赖，并构建 Web 与终端，耗时较长。后续命令均在 `deploy/` 中执行。

### 凭证

- `PI_WEB_PASSWORD` 必填，留空时 Compose 拒绝启动。
- 当前默认模型需在 `.env` 配置 `OPENAI_RELAY_BASE_URL` 和 `OPENAI_RELAY_API_KEY`；具体模型配置见 [环境配置](../docs/环境配置.md#模型与插件)。未提供模型密钥仍可登录 Web，但不能调用该模型。
- 仅 `.env.example` 空凭证模板入库；复制得到的 `.env` 被 Git 忽略，**不要强制添加或提交密钥**。也可使用 `.env.local`，此时所有 `docker compose` 命令均需加上 `--env-file .env.local`。
- 含 `$` 或 `#` 等特殊字符的值请用单引号包裹。凭证仅在运行时注入，不传入镜像构建；不要将展开后的 `docker compose config` 输出到公共日志。

### 访问 Web

默认仅监听服务器的 `127.0.0.1:30141`。在自己的电脑建立 SSH 隧道：

```sh
ssh -N -L 30141:127.0.0.1:30141 user@server
```

打开 <http://localhost:30141>，使用配置的密码登录。`.env` 中 `WORKBOT_WEB_AUTOSTART=1` 控制 Web 随 chat 启动，`WORKBOT_TUI_ENABLED=1` 启用独立 Pi TUI；两项默认开启，设为 `0` 可分别关闭。Web 和独立 Pi TUI 的操作见 [使用说明](../docs/使用.md#按需使用-web)。

对外提供服务时，使用 HTTPS 反向代理或可信 VPN。代理须支持 WebSocket，并在 `PI_WEB_ALLOWED_HOSTS` 中填写实际访问域名。不要直接向公网开放 HTTP；仅更改监听地址不能保证访问安全。

## 个人助手约定

`compose.yml` 默认将本目录的 `chat/AGENTS.md` 只读挂载到镜像的 chat 角色配置路径，初始化时完整复制到运行配置，不与默认团队约定合并，也不影响根目录部署或 code 角色。

助手面向日常生活、工作、学习和技术开发，简单任务直接处理，不强制走 Issue → code Job → MR 流程；对外发送、付款、部署等高风险操作仍需明确授权，开发任务遵守目标仓库自己的约定。

编辑 `chat/AGENTS.md` 调整称呼、沟通风格和工作习惯。修改后先保存重要工作文件，再执行下文的 `--force-recreate` 命令并新建会话。

角色约定不是权限隔离；仅向可信用户开放访问，并按需提供凭证。`dispatch_code` 和 `/workbot` 仍可用，但不会因个人助手模式自动派发任务。助手没有默认接入个人日历、邮箱或定时提醒服务；仅会话持久化，重要文件需另行导出或备份。

## 配置项目、模型与 IM

模型、插件和渠道参数由 `configs/` 提供，预拉取项目使用本目录的 `projects.json`，默认 `[]`。

- **预拉取项目**：按 `configs/projects.json` 的格式填写本目录的 `projects.json`，并配置 `GITLAB_HOST`、`GITLAB_TOKEN`。清单不是项目权限白名单。
- **自定义模型**：地址通过 `.env` 的 `OPENAI_RELAY_BASE_URL` 提供，模型定义保留在 `configs/shared/models.json`；端点需支持所配置的模型及 `openai-responses` API，详见 [模型配置](../docs/环境配置.md#模型与插件)。
- **飞书**：在 `.env` 同时填写 `FEISHU_APP_ID`、`FEISHU_APP_SECRET` 即启用。
- **企业微信**：在 `.env` 同时填写 `WECOM_BOT_ID`、`WECOM_BOT_SECRET` 即启用。
- **只使用 Web**：两组 IM 凭证均留空。渠道参数与准入说明见 [IM 配置](../docs/环境配置.md#im-配置)。
- **自定义模型或渠道参数**：执行 `cp ../configs/chat/settings.json ./chat/settings.json`，编辑后在 `compose.yml` 的 `volumes` 中添加 `- ./chat/settings.json:/opt/workbot/configs/chat/settings.json:ro`，按完整文件覆盖。密钥放 `.env`；空白名单允许所有发送者，请按使用范围设置准入。
- **扩展模型与插件**：模型端点、新增凭证和插件更新按 [环境配置](../docs/环境配置.md) 操作。新增环境变量须在 Compose `environment` 中显式传入；修改插件清单时，需同步角色安装清单和锁文件并重新构建镜像。

修改挂载配置或 `.env` 后，重新创建容器：

```sh
docker compose up -d --force-recreate --wait --wait-timeout 420
```

## 接入编码任务

个人助手可按授权在当前工作区直接处理开发任务，无需准备 GitLab code Job 设施。若需要沿用团队的 Issue → code Job → MR 流程，仍可按明确请求派发任务：需配置控制项目、服务账号令牌、code Runner 和 `code` environment 凭证，并发布所选 ref 对应的 code 镜像，详见 [code 执行条件](../docs/使用.md#code-执行条件)。

本目录只部署常驻 chat/Web，不部署 Runner 或本地任务调度器。

## 内置终端的中文删除

运行镜像通过 `SHELL=/bin/bash` 为 Pi Web 内置终端选择 Bash。默认 `/bin/sh`（Debian 的 dash）可能已删除输入，却只擦除一列，导致双列汉字留在屏幕上；这与独立 Pi TUI 的输入法处理不同。旧容器可在内置终端执行 `exec bash` 临时解决；永久生效需重建镜像及容器，并关闭旧终端标签后新建终端。不要用 Dockerfile 的 `SHELL` 构建指令替代该环境变量。

## 状态与日志

```sh
docker compose ps
docker compose logs -f --tail 100 chat
# Web 使用独立日志文件，不写入 chat 的标准输出。
docker compose exec chat tail -n 100 /runtime/web.log
```

`up -d` 仅等待容器启动；加上 `--wait --wait-timeout 420` 才会等待健康检查通过。健康检查通过 `/runtime/healthy` 确认 chat 初始化完成；启用 IM 后，还需等待所有启用渠道就绪。健康检查不验证 Web 页面、模型调用或 GitLab 权限，部署后仍需实际验收。

## 更新、停止与数据

```sh
# 更新前备份会话，并妥善保存本地配置和凭证。
git pull --ff-only
docker compose build --pull chat
docker compose up -d --no-build --wait --wait-timeout 420

# 停止并移除容器，保留会话卷。
docker compose down
```

**仅会话持久化。** `chat-sessions` 命名卷保存会话；项目工作区和在线配置随容器重建清空。代码修改需及时推送，在线配置需保存到宿主配置文件或回收到 `configs/`。`docker compose down -v` 会删除会话卷，不要用于日常更新。备份与恢复见 [运维说明](../docs/运维.md#会话备份)。

本目录的 Compose 项目名为 `pi-workbot-standalone`。

## 镜像构建与维护

两种部署共用根目录 `Dockerfile`，默认使用 `naivetoby/pi-workbot-dev:latest` 研发底座，可通过 `.env` 的 `WORKBOT_BASE_IMAGE` 替换，包含语言工具链、Bun、glab、语言服务器和检查器。应用阶段按职责分层：

- `base`：按锁文件安装 Workbot 依赖，复制源码和共享资产。
- `web-build` → `terminal-build`：构建 Web 与终端，复用前端源码和依赖。
- `base` → `chat-assets`：安装角色插件，验证资产和 Pi/lens。
- `base` → `tui-check` → `chat`：验证 Web/终端产物，组合已验收的角色资源。

Web/TUI 源码和构建依赖未变时可复用缓存，业务源码和角色配置变更无需重编译前端。依赖以 `vscode` 用户安装，复制文件时设置归属，避免递归修改权限产生额外镜像层。根目录 `.dockerignore` 排除整个 `deploy/`、本地 Compose override 和嵌套 `.env` 文件，本地凭证及挂载配置不会发送给构建器。

只维护一份 Dockerfile，GitLab 构建和独立部署使用相同应用阶段与验收要求。替换底座需保留 `vscode` 用户及运行工具，并通过 Linux 镜像检查。`build --pull` 会拉取最新研发底座。角色插件依赖由锁文件固定，Web 源码版本由仓库记录固定。
