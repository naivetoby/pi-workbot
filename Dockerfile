# syntax=docker/dockerfile:1
ARG BASE_IMAGE=naivetoby/pi-workbot-dev:latest
# CI 默认运行测试，独立部署设为 0。
ARG WORKBOT_BUILD_TESTS=1
FROM ${BASE_IMAGE} AS base
USER root
WORKDIR /opt/workbot
RUN mkdir -p /opt/workbot/configs /runtime/pi/sessions /workspace \
    && chown vscode:vscode /opt/workbot /opt/workbot/configs /runtime /runtime/pi /runtime/pi/sessions /workspace
# Web 按 SHELL 启动交互终端；dash 的退格回显不处理汉字双列宽度。
ENV HOME=/home/vscode SHELL=/bin/bash PI_OFFLINE=1 PI_TELEMETRY=0 \
    PI_CODING_AGENT_DIR=/runtime/pi WORKBOT_WORKSPACE=/workspace \
    WORKBOT_PROJECTS_FILE=/opt/workbot/configs/projects.json \
    PATH=/opt/workbot/bin:$PATH
USER vscode
COPY --chown=vscode:vscode package.json bun.lock bunfig.toml ./
COPY --chown=vscode:vscode patches ./patches
RUN bun install --frozen-lockfile --production --ignore-scripts
COPY --chown=vscode:vscode src ./src
COPY --chown=vscode:vscode scripts ./scripts
COPY --chown=vscode:vscode test/fixtures/lens-*.ts ./test/fixtures/
COPY --chown=vscode:vscode configs/projects.json ./configs/projects.json
COPY --chown=vscode:vscode configs/shared ./configs/shared
COPY --chown=vscode:vscode bin ./bin
RUN chmod +x bin/*
ARG WORKBOT_BUILD_TESTS

# Web 只依赖固定源码、补丁和构建脚本，业务代码与角色配置变更不应触发重编译。
FROM ${BASE_IMAGE} AS web-build
USER root
WORKDIR /opt/workbot
COPY package.json bunfig.toml ./
COPY scripts/prepare-web.ts ./scripts/prepare-web.ts
COPY src/runtime/paths.ts src/runtime/process.ts src/runtime/types.ts ./src/runtime/
COPY web ./web
ENV BUN_INSTALL_CACHE_DIR=/var/cache/bun
ARG WORKBOT_BUILD_TESTS
RUN --mount=type=cache,id=pi-workbot-web-bun,target=/var/cache/bun \
    if [ "$WORKBOT_BUILD_TESTS" = "0" ]; then bun run build:web --skip-tests; else bun run build:web; fi

# ttyd 保留固定后端；浏览器页复用 web-build 中同一套 Pi Web 源码和依赖。
FROM web-build AS terminal-build
USER root
WORKDIR /opt/workbot
RUN apt-get update && apt-get install -y --no-install-recommends \
    cmake build-essential pkg-config libwebsockets-dev libwebsockets-evlib-uv libjson-c-dev libuv1-dev \
    && rm -rf /var/lib/apt/lists/*
COPY terminal ./terminal
COPY scripts/prepare-tui.ts ./scripts/prepare-tui.ts
COPY src/runtime/paths.ts src/runtime/process.ts src/runtime/types.ts ./src/runtime/
RUN cd terminal && sha256sum -c *.sha256 && mkdir /tmp/ttyd \
    && tar -xzf ttyd-*.tar.gz --strip-components=1 -C /tmp/ttyd \
    && cmake -S /tmp/ttyd -B /tmp/ttyd/build -DCMAKE_BUILD_TYPE=Release -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
    && cmake --build /tmp/ttyd/build -j2
RUN bun scripts/prepare-tui.ts

FROM base AS code
# code 只使用已有工具；chat 保留 lens 的按需安装行为。
ENV WORKBOT_ROLE=code PI_LENS_DISABLE_LSP_INSTALL=1 PI_LENS_DISABLE_TOOL_INSTALL=1
COPY --chown=vscode:vscode configs/code ./configs/code
RUN bun scripts/prepare-pi.ts configs/code
RUN if [ "$WORKBOT_BUILD_TESTS" != "0" ]; then bun scripts/smoke-assets.ts code; fi
RUN --network=none if [ "$WORKBOT_BUILD_TESTS" != "0" ]; then bun scripts/smoke-lens.ts code; fi
CMD ["bun", "src/cli.ts", "code"]

# 插件兼容性使用角色自己的锁文件验证，不要求先构建 Web/TUI。
FROM base AS chat-assets
ENV WORKBOT_ROLE=chat
COPY --chown=vscode:vscode configs/chat ./configs/chat
RUN bun scripts/prepare-pi.ts configs/chat
RUN if [ "$WORKBOT_BUILD_TESTS" != "0" ]; then bun scripts/smoke-assets.ts chat; fi
RUN --network=none if [ "$WORKBOT_BUILD_TESTS" != "0" ]; then bun scripts/smoke-lens.ts chat; fi

# 独立验证终端运行依赖与会话生命周期。
FROM base AS tui-check
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    caddy tmux libwebsockets-dev libwebsockets-evlib-uv libjson-c-dev libuv1-dev \
    && rm -rf /var/lib/apt/lists/*
COPY --from=terminal-build /tmp/ttyd/build/ttyd /usr/local/bin/ttyd
COPY --from=terminal-build /opt/workbot/terminal/LICENSE /usr/share/doc/ttyd/LICENSE
COPY --from=terminal-build --chown=vscode:vscode /opt/workbot/.cache/ttyd /opt/workbot/.cache/ttyd
COPY --chown=vscode:vscode configs/tmux.conf ./configs/tmux.conf
USER vscode
COPY --from=web-build --chown=vscode:vscode /opt/workbot/.cache/pi-web /opt/workbot/.cache/pi-web
COPY --chown=vscode:vscode test/fixtures/tui-session-probe.ts ./test/fixtures/tui-session-probe.ts
RUN if [ "$WORKBOT_BUILD_TESTS" != "0" ]; then bun scripts/smoke-tui.ts; fi

FROM tui-check AS chat
COPY --from=chat-assets --chown=vscode:vscode /opt/workbot/configs/chat ./configs/chat
ENV WORKBOT_ROLE=chat
EXPOSE 30141
CMD ["bun", "src/cli.ts", "chat"]
