// @env node
import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { chmod } from 'node:fs/promises'
import { ROOT } from '../src/runtime/paths.ts'
import { run } from '../src/runtime/process.ts'
import { fixture, testEnvironment } from './helpers.ts'

interface NoticeJob {
  extends: string
  rules: { if: string; when: string }[]
  script: string[]
  needs?: unknown
}

interface Pipeline {
  stages: string[]
  default: { image: string; tags: string[] }
  variables: Record<string, string>
  check: { image: string }
  'check-assets': { image: string; rules: { if: string; changes: string[] }[]; script: string[] }
  'check-web': { image: string; rules: { if: string; changes: string[] }[]; script: string[] }
  'check-tui': { stage: string; rules: { if: string; changes: string[] }[]; script: string[] }
  'check-lens': { stage: string; rules: { if: string; changes: string[] }[]; script: string[] }
  'build-images': { script: string[] }
  '.notice': {
    stage: string
    image: string
    environment: { name: string }
    allow_failure: boolean
  }
  'deploy-chat': { environment: string; resource_group: string; script: string[] }
  'notice-deploy': NoticeJob
  'notice-deploy-failure': NoticeJob
}

async function pipeline(): Promise<Pipeline> {
  return Bun.YAML.parse(await Bun.file(join(ROOT, '.gitlab-ci.example.yml')).text()) as Pipeline
}

const deployCondition = '$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH'

describe('部署通知流水线', () => {
  it.each([
    { name: '健康', fail: false },
    { name: '健康等待失败', fail: true },
  ])('实际执行部署脚本：$name', async ({ fail }) => {
    const config = await fixture()
    const bin = join(config.piDir, '../bin')
    const calls = join(config.piDir, '../docker-calls')
    const docker = join(bin, 'docker')
    await Bun.write(
      docker,
      `#!/bin/sh
printf '%s\\n' "$*" >> "$WORKBOT_TEST_CALLS"
if [ "$2" = up ] && [ "$WORKBOT_TEST_FAIL" = 1 ]; then exit 9; fi
`,
    )
    await chmod(docker, 0o755)
    const deploy = (await pipeline())['deploy-chat']
    expect(deploy.resource_group).toBe(deploy.environment)
    const script = deploy.script.join('\n')
    const execution = run(['/bin/sh', '-ec', script], {
      env: testEnvironment({
        PATH: bin,
        WORKBOT_TEST_CALLS: calls,
        WORKBOT_TEST_FAIL: fail ? '1' : '0',
      }),
    })
    if (fail) await expect(execution).rejects.toThrow('退出码 1')
    else await expect(execution).resolves.toBe('')
    const commands = await Bun.file(calls).text()
    expect(commands).toContain('compose up --no-build --wait --wait-timeout 420 chat')
    if (fail) {
      expect(commands).toContain('compose ps --all chat')
      expect(commands).toContain('compose logs --no-color --tail 100 chat')
    } else {
      expect(commands).not.toContain('compose logs')
    }
  })

  it('检查、通知与构建使用相同的基础镜像引用', async () => {
    const ci = await pipeline()
    for (const job of [ci['check-assets'], ci['check-web'], ci['.notice']])
      expect(job.image).toBe(ci.check.image)
    const dockerfile = await Bun.file(join(ROOT, 'Dockerfile')).text()
    expect(ci.check.image).toBe('$WORKBOT_BASE_IMAGE')
    expect(dockerfile).toContain(`ARG BASE_IMAGE=${ci.variables.WORKBOT_BASE_IMAGE}`)
    expect(ci.default).toEqual({ image: '$WORKBOT_CI_IMAGE', tags: ['$WORKBOT_BUILD_RUNNER'] })
    expect(ci.variables.WORKBOT_CI_IMAGE).toBe('docker:cli')
  })

  it('仅 code 镜像禁止 lens 自动安装，chat 不继承这些开关', async () => {
    const dockerfile = await Bun.file(join(ROOT, 'Dockerfile')).text()
    const stages = dockerfile.split(/(?=^FROM )/m)
    const code = stages.find((stage) => stage.startsWith('FROM base AS code\n'))

    expect(code).toBeDefined()
    for (const flag of ['PI_LENS_DISABLE_LSP_INSTALL', 'PI_LENS_DISABLE_TOOL_INSTALL']) {
      expect(code).toContain(`${flag}=1`)
      for (const stage of stages.filter((stage) => stage !== code)) {
        expect(stage).not.toContain(flag)
      }
    }
    expect(dockerfile).toContain('FROM base AS tui-check')
    expect(dockerfile).toContain('FROM tui-check AS chat')
  })

  it('角色构建沿用上游用户，默认开启测试并配置 Pi/lens 禁网验收', async () => {
    const dockerfile = (await Bun.file(join(ROOT, 'Dockerfile')).text()).replace(/\\\n\s*/g, ' ')
    expect(dockerfile).toContain('USER vscode')
    expect(dockerfile).toContain('ENV HOME=/home/vscode')
    expect(dockerfile).not.toContain('bun:bun')
    expect(dockerfile).toMatch(/^ARG\s+WORKBOT_BUILD_TESTS=1\s*$/m)
    for (const stage of ['base', 'web-build']) {
      const source = dockerfile.split(` AS ${stage}\n`)[1]?.split('\nFROM ')[0]
      expect(source).toMatch(/^ARG\s+WORKBOT_BUILD_TESTS\s*$/m)
    }
    const offlineRuns = dockerfile.match(/^RUN\s+--network=none\b.*$/gm)?.join('\n') ?? ''
    for (const role of ['code', 'chat']) {
      expect(dockerfile).toContain(`bun scripts/prepare-pi.ts configs/${role}`)
      expect(offlineRuns).toContain(`bun scripts/smoke-lens.ts ${role}`)
    }
    expect(dockerfile).toContain(
      'COPY --from=chat-assets --chown=vscode:vscode /opt/workbot/configs/chat',
    )
  })

  it('合并前构建两种角色的 lens 验收层，构建均拉取新底座且检查不发布镜像', async () => {
    const ci = await pipeline()
    const job = ci['check-lens']
    expect(job.stage).toBe('check')
    expect(job.rules).toHaveLength(1)
    expect(job.rules[0]?.if).toBe('$MODE != "code"')
    for (const path of [
      'configs/**/*',
      'scripts/smoke-lens.ts',
      'test/fixtures/lens-*.ts',
      'Dockerfile',
      '.gitlab-ci.yml',
      '.gitlab-ci.example.yml',
    ])
      expect(job.rules[0]?.changes).toContain(path)
    expect(job.script).toEqual([
      'docker build --pull --provenance=false --build-arg BASE_IMAGE="$WORKBOT_BASE_IMAGE" --target code .',
      'docker build --pull --provenance=false --build-arg BASE_IMAGE="$WORKBOT_BASE_IMAGE" --target chat-assets .',
    ])
    const builds = ci['build-images'].script.filter((line) => line.startsWith('docker build'))
    expect(builds).toHaveLength(2)
    for (const build of builds) {
      expect(build).toContain('--pull')
      expect(build).toContain('--build-arg BASE_IMAGE="$WORKBOT_BASE_IMAGE"')
    }
  })

  it('资产与 Web 变更执行对应检查，API code 流水线不运行环境构建验证', async () => {
    const ci = await pipeline()
    for (const job of [ci['check-assets'], ci['check-web']]) {
      expect(job.rules[0]?.if).toBe('$MODE != "code"')
      expect(job.rules[0]?.changes).toContain('package.json')
      expect(job.rules[0]?.changes).toContain('.gitlab-ci.yml')
      expect(job.rules[0]?.changes).toContain('.gitlab-ci.example.yml')
    }
    expect(ci['check-assets'].rules[0]?.changes).toContain('configs/**/*')
    expect(ci['check-assets'].script).toContain('bun run check:assets')
    expect(ci['check-web'].rules[0]?.changes).toContain('web/**/*')
    expect(ci['check-web'].script).toContain('bun run check:web')
  })

  it('TUI 变更在 MR 和普通分支构建真实 Linux 验收层，不发布镜像或运行 code 任务', async () => {
    const job = (await pipeline())['check-tui']
    expect(job.stage).toBe('check')
    expect(job.rules).toHaveLength(1)
    expect(job.rules[0]?.if).toBe('$MODE != "code"')
    for (const path of [
      'web/**/*',
      'terminal/**/*',
      'src/chat/**/*',
      'scripts/smoke-tui.ts',
      'test/fixtures/tui-session-probe.ts',
      'Dockerfile',
      '.gitlab-ci.yml',
      '.gitlab-ci.example.yml',
    ])
      expect(job.rules[0]?.changes).toContain(path)
    expect(job.script).toEqual([
      'docker build --pull --provenance=false --build-arg BASE_IMAGE="$WORKBOT_BASE_IMAGE" --target tui-check .',
    ])
    const dockerfile = await Bun.file(join(ROOT, 'Dockerfile')).text()
    const terminalStage = dockerfile
      .split('FROM base AS tui-check')[1]
      ?.split('FROM tui-check AS chat')[0]
    expect(terminalStage).toMatch(/\bbun\s+scripts\/smoke-tui\.ts\b/)
    expect(terminalStage).toContain('test/fixtures/tui-session-probe.ts')
    expect(terminalStage).not.toContain('prepare-pi.ts configs/chat')
    expect(dockerfile).toContain('FROM tui-check AS chat')
  })

  it('默认分支 push 分别按成功和失败触发，其他分支、MR 和 API 编码流水线不匹配', async () => {
    const ci = await pipeline()
    expect(ci['notice-deploy'].rules).toEqual([{ if: deployCondition, when: 'on_success' }])
    expect(ci['notice-deploy-failure'].rules).toEqual([{ if: deployCondition, when: 'on_failure' }])
    expect(ci['notice-deploy'].script).toEqual(['bun scripts/notice.ts deploy-success'])
    expect(ci['notice-deploy-failure'].script).toEqual(['bun scripts/notice.ts deploy-failure'])
  })

  it('通知位于检查、构建和部署之后，使用独立镜像且通知故障不改变流水线结果', async () => {
    const ci = await pipeline()
    const base = ci['.notice']
    expect(base).toMatchObject({
      stage: 'notice',
      image: '$WORKBOT_BASE_IMAGE',
      environment: { name: 'notice' },
      allow_failure: true,
    })
    expect(ci.stages.at(-1)).toBe(base.stage)
    for (const stage of ['check', 'build', 'deploy']) {
      expect(ci.stages).toContain(stage)
      expect(ci.stages.indexOf(stage)).toBeLessThan(ci.stages.indexOf(base.stage))
    }
    for (const job of [ci['notice-deploy'], ci['notice-deploy-failure']]) {
      expect(job.extends).toBe('.notice')
      expect(job.needs).toBeUndefined()
    }
  })
})
