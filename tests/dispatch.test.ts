import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { resolveConfig, defaultsOf } from '../src/config.ts'
import { Dispatcher, renderDispatchValue } from '../src/dispatch/tool.ts'
import type { Agent, SubagentActivation, SubagentResult, SubagentService } from '../src/host.ts'
import { RepoRegistry } from '../src/repos/registry.ts'
import type { EditableSettings } from '../src/settings/contract.ts'
import { SkillUpdater } from '../src/skill-update/tool.ts'
import { createAppRepo, createRepos, tempDir } from './helpers.ts'

let server: Server
let port = 0
beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200)
    res.end('packed-log')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
})
afterAll(async () => { await new Promise(resolve => server.close(resolve)) })

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

interface Started {
  spec: Parameters<SubagentService['startActivation']>[0]
  settle: (result: SubagentResult) => void
  dispose: ReturnType<typeof vi.fn>
}

function fakeSubagents(): { service: SubagentService; started: Started[] } {
  const started: Started[] = []
  const service: SubagentService = {
    getProvider: () => ({}),
    resolveMaxDepth: () => 1,
    startActivation: async (spec) => {
      let settle!: (result: SubagentResult) => void
      const result = new Promise<SubagentResult>((resolve) => { settle = resolve })
      const dispose = vi.fn(async () => {})
      started.push({ spec, settle, dispose })
      const activation: SubagentActivation = { childId: `child-${started.length}`, result, dispose }
      return activation
    },
  }
  return { service, started }
}

async function setup(overrides: Partial<EditableSettings> = {}, proposals = false) {
  const { dir, cleanup } = await tempDir()
  cleanups.push(cleanup)
  const origin = await createAppRepo(join(dir, 'order-service'))
  const project = join(dir, 'project')
  await createAppRepo(project)
  const repos = createRepos(join(dir, 'dsh-repo'))
  const registry = new RepoRegistry({ repos: () => repos, onChange: () => {} })
  const settings: EditableSettings = {
    ...defaultsOf(resolveConfig({})),
    repos: [{ url: origin }],
    download: { allowedHosts: ['127.0.0.1'], maxBytes: 1024, timeoutMs: 5000 },
    ...overrides,
  }
  registry.configure(settings.repos)
  await registry.syncAll()
  const { service, started } = fakeSubagents()
  const updater = new SkillUpdater({ registry, settings: () => settings, approval: () => undefined, repos: () => repos })
  const dispatcher = new Dispatcher({
    registry,
    ...proposals ? { proposals: updater } : {},
    subagents: service,
    settings: () => settings,
    provider: 'spawn',
    workingDirectory: () => ({ ensure: async () => join(project, 'sample-logs') }),
    now: () => new Date(2026, 9, 25, 9, 30, 0),
  })
  const parent: Agent = { id: 'parent', session: { header: { id: 'parent', cwd: project } } }
  return { dir, project, registry, dispatcher, started, parent, settings }
}

async function waitForStarts(started: Started[], count: number): Promise<void> {
  for (let attempt = 0; attempt < 500 && started.length < count; attempt += 1) await new Promise(resolve => setTimeout(resolve, 10))
  expect(started).toHaveLength(count)
}

describe('guanxiang_dispatch', () => {
  it('starts one child per task in the app repository and returns every result', async () => {
    const { dir, project, dispatcher, started, parent, registry } = await setup()
    const log = join(project, 'sample-logs', 'order-service.log')
    const running = dispatcher.execute({
      tasks: [{
        app: 'order-service',
        question: '21 点下单报 500',
        logs: [{ path: '../sample-logs/order-service.log' }, { url: `http://127.0.0.1:${port}/bucket/app.tar.gz?sig=x`, filter: 'tag=order' }],
      }],
    }, { signal: new AbortController().signal, agent: parent })
    await waitForStarts(started, 1)
    const [child] = started
    expect(registry.status()[0]?.activeRuns).toBe(1)
    expect(child?.spec).toMatchObject({ provider: 'spawn', label: '订单服务分析', delivery: 'caller', request: { parent, maxDepth: 1 } })
    expect(child?.spec.request.cwd).toMatch(new RegExp(`^${join(dir, 'dsh-repo', 'mirrors', '.snapshots', 'local')}/order-service-[0-9a-f]{8}/[0-9a-f]{12}-[0-9a-f]{6}$`))
    const prompt = child?.spec.request.prompt[0]?.text as string
    expect(prompt.split('\n')[0]).toBe('/log-analysis')
    const workDir = join(project, 'sample-logs', '.guanxiang', 'runs')
    expect(prompt).toContain(`- \`${log}\``)
    expect(prompt).toContain(`（下载自 http://127.0.0.1:${port}/bucket/app.tar.gz?sig=x）；只看本应用相关部分：tag=order`)
    expect(prompt).toContain(workDir)
    expect(prompt).not.toContain('SKILL 改进')
    child?.settle({ stopReason: 'completed', output: [{ type: 'text', text: '根因：促销商品没有 SKU' }] })
    const value = await running
    expect(value.runId).toMatch(/^20261025-093000-[0-9a-f]{6}$/)
    expect(value.runDir).toBe(join(workDir, value.runId))
    expect(value.results).toEqual([{
      app: 'order-service',
      name: '订单服务',
      status: 'completed',
      childId: 'child-1',
      output: '根因：促销商品没有 SKU',
      workDir: join(value.runDir, '1-order-service'),
      logs: [log, join(value.runDir, '1-order-service', '2-app.tar.gz')],
    }])
    expect(await readFile(join(value.runDir, '1-order-service', '2-app.tar.gz'), 'utf8')).toBe('packed-log')
    expect(child?.dispose).toHaveBeenCalledTimes(1)
    expect(registry.status()[0]?.activeRuns).toBe(0)
    expect(renderDispatchValue(value)[0]?.text).toContain('### 订单服务（order-service）— 完成')
  })

  it('tells children how to propose SKILL changes and reports the proposals of completed tasks', async () => {
    const { project, dispatcher, started, parent } = await setup({ skillUpdates: { enabled: true, maxFiles: 4, maxFileBytes: 65536 } }, true)
    const path = join(project, 'sample-logs', 'order-service.log')
    const running = dispatcher.execute({ tasks: [{ app: 'order-service', question: 'q', logs: [{ path }] }, { app: 'order-service', question: 'q2', logs: [{ path }] }] }, { signal: new AbortController().signal, agent: parent })
    await waitForStarts(started, 2)
    const prompt = started[0]?.spec.request.prompt[0]?.text as string
    expect(prompt).toContain('## SKILL 改进（可选）')
    const workDir = /`([^`]+)\/skill-proposal\/reason\.md`/.exec(prompt)?.[1] as string
    expect(prompt).toContain(`复制到 \`${workDir}/skill-proposal/files/\``)
    await mkdir(join(workDir, 'skill-proposal', 'files'), { recursive: true })
    await writeFile(join(workDir, 'skill-proposal', 'reason.md'), '缺少 traceId 说明')
    await writeFile(join(workDir, 'skill-proposal', 'files', 'SKILL.md'), '# 新版\n')
    started[0]?.settle({ stopReason: 'completed', output: [{ type: 'text', text: '结论' }] })
    started[1]?.settle({ stopReason: 'error', output: [] })
    const value = await running
    expect(value.results[0]?.skillProposal).toEqual({ ok: true, files: [{ path: '.dsh/skills/log-analysis/SKILL.md', added: 1, removed: expect.any(Number) }], diffPath: join(workDir, 'skill-proposal.diff') })
    expect(value.results[1]?.skillProposal).toBeUndefined()
    const text = renderDispatchValue(value)[0]?.text
    expect(text).toContain('SKILL 修改提议：.dsh/skills/log-analysis/SKILL.md（+1 −')
    expect(text).toContain(`提交时调用 guanxiang_propose_skill，workDir 为 ${workDir}。`)
  })

  it('rejects unknown apps, unreadable paths, disallowed URLs, and too many tasks before starting anything', async () => {
    const { project, dispatcher, started, parent } = await setup({ maxAppsPerRequest: 1 })
    const exec = { signal: new AbortController().signal, agent: parent }
    const path = join(project, 'sample-logs', 'order-service.log')
    await expect(dispatcher.execute({ tasks: [{ app: 'pay-service', question: 'q', logs: [{ path }] }] }, exec)).rejects.toThrow('不在应用注册表中')
    await expect(dispatcher.execute({ tasks: [{ app: 'order-service', question: 'q', logs: [{ path: '/nope.log' }] }] }, exec)).rejects.toThrow('日志路径不可读：/nope.log')
    await expect(dispatcher.execute({ tasks: [{ app: 'order-service', question: 'q', logs: [{ url: 'https://evil.example.net/x' }] }] }, exec)).rejects.toThrow('不在下载白名单中')
    await expect(dispatcher.execute({ tasks: [{ app: 'order-service', question: 'q', logs: [{ path }] }, { app: 'order-service', question: 'q', logs: [{ path }] }] }, exec)).rejects.toThrow('一次最多派发 1 个任务')
    await expect(dispatcher.execute({ tasks: [{ app: 'order-service', question: 'q', logs: [{ path, url: 'x' }] }] }, exec)).rejects.toThrow('参数不合法')
    await expect(dispatcher.execute({ tasks: [{ app: 'order-service', question: 'q', logs: [{ path }] }] }, { ...exec, agent: { ...parent, session: { header: { id: 'c', cwd: project, delegationDepth: 1 } } } })).rejects.toThrow('不能在子 Agent 中调用')
    expect(started).toHaveLength(0)
  })

  it('stops children still running at the dispatch timeout', async () => {
    const { project, dispatcher, started, parent } = await setup({ dispatchTimeoutMs: 1000 })
    const path = join(project, 'sample-logs', 'order-service.log')
    const running = dispatcher.execute({ tasks: [{ app: 'order-service', question: 'q', logs: [{ path }] }] }, { signal: new AbortController().signal, agent: parent })
    await waitForStarts(started, 1)
    const value = await running
    expect(value.results[0]).toMatchObject({ status: 'timeout', diagnostic: '超过派发等待上限 1000 ms' })
    expect(started[0]?.dispose).toHaveBeenCalledTimes(1)
    expect((await stat(value.results[0]!.workDir)).isDirectory()).toBe(true)
  })

  it('stops children and rejects when the call is cancelled', async () => {
    const { project, dispatcher, started, parent } = await setup()
    const controller = new AbortController()
    const path = join(project, 'sample-logs', 'order-service.log')
    const running = dispatcher.execute({ tasks: [{ app: 'order-service', question: 'q', logs: [{ path }] }] }, { signal: controller.signal, agent: parent })
    await waitForStarts(started, 1)
    controller.abort(new Error('user cancelled'))
    await expect(running).rejects.toThrow('user cancelled')
    expect(started[0]?.dispose).toHaveBeenCalledTimes(1)
  })
})
