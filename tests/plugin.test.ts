import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'
import type { HostContext, HostCredentials, SkillProvider, SkillProviderControl, ToolActivationContext, ToolDefinition } from '../src/host.ts'
import type { StateWire } from '../src/settings/contract.ts'
import { runGit } from '../src/repos/git.ts'
import type { GitRunner } from '../src/repos/git.ts'
import { commitFile, createAppRepo, git, serveGitOverHttp, tempDir, waitFor } from './helpers.ts'

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

interface Harness {
  ctx: HostContext
  tools: { definition: ToolDefinition<unknown>; when?: (context: ToolActivationContext) => boolean | Promise<boolean>; disposed: boolean }[]
  skills: SkillProvider[]
  base: string
  rejection: { value: 401 | 403 | undefined }
  dispose: () => Promise<void>
}

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

async function harness(services: Record<string, unknown> = {}): Promise<Harness> {
  const routes = new Map<string, Handler>()
  const tools: Harness['tools'] = []
  const skills: SkillProvider[] = []
  const disposers: (() => void)[] = []
  const rejection: Harness['rejection'] = { value: undefined }
  const webServer = { register: (route: { path: string; handler: Handler }) => { routes.set(route.path, route.handler); return () => { routes.delete(route.path) } } }
  const connection = { requestRejection: () => rejection.value }
  const ctx: HostContext = {
    tools: {
      register: (definition, options) => {
        const entry = { definition: definition as ToolDefinition<unknown>, when: options?.when, disposed: false }
        tools.push(entry)
        return () => { entry.disposed = true }
      },
    },
    skills: {
      registerProvider: (create) => {
        const control: SkillProviderControl = { signal: new AbortController().signal, invalidate: vi.fn() }
        skills.push(create(control))
        return () => {}
      },
    },
    subagents: { getProvider: () => ({}), resolveMaxDepth: () => 1, startActivation: () => Promise.reject(new Error('not used')) },
    get: (name: string) => ({ webServer, connection, ...services } as Record<string, unknown>)[name],
    effect: (callback) => {
      const dispose = callback()
      const wrapped = (): void => { dispose?.() }
      disposers.push(wrapped)
      return wrapped
    },
    inject: (_deps, callback) => { callback(ctx) },
  }
  const server: Server = createServer((req, res) => {
    const handler = routes.get(new URL(req.url ?? '/', 'http://x').pathname)
    if (handler === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    void handler(req, res)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return {
    ctx, tools, skills, base, rejection,
    dispose: async () => {
      for (const dispose of disposers.reverse()) dispose()
      await new Promise(resolve => server.close(resolve))
    },
  }
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T
}

describe('plugin', () => {
  it('registers the entry skill, clones repositories, and offers the dispatch tool to top-level agents only', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    const origin = await createAppRepo(join(dir, 'order-service'))
    const h = await harness()
    cleanups.push(h.dispose)
    apply(h.ctx, { reposDir: join(dir, 'repos'), repos: [{ url: origin }] }, { overlayPath: join(dir, 'settings.json') })
    expect(h.skills.map(skill => skill.name)).toEqual(['dsh-guanxiang'])
    expect(h.tools.map(tool => tool.definition.name)).toEqual(['guanxiang_dispatch', 'guanxiang_propose_skill'])
    const [tool, propose] = h.tools
    const signal = new AbortController().signal
    const step = (depth?: number) => ({ agent: { id: 'a', session: { header: { id: 'a', ...depth === undefined ? {} : { delegationDepth: depth } } } }, signal })
    // The condition waits for the first sync, so a step prepared during startup still sees the cloned application.
    expect(await tool!.when?.(step())).toBe(true)
    expect(await tool!.when?.(step(1))).toBe(false)
    // SKILL proposals are off by default.
    expect(await propose!.when?.(step())).toBe(false)
    const [candidate] = await h.skills[0]!.list({})
    expect((await h.skills[0]!.get(candidate!, {}))?.content).toContain('`order-service`')
  })

  it('offers the SKILL proposal tool to top-level agents once proposals are enabled and mentions it in /guanxiang', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    const origin = await createAppRepo(join(dir, 'order-service'))
    const h = await harness()
    cleanups.push(h.dispose)
    apply(h.ctx, { reposDir: join(dir, 'repos'), repos: [{ url: origin }], skillUpdates: { enabled: true } }, { overlayPath: join(dir, 'settings.json') })
    const propose = h.tools.find(tool => tool.definition.name === 'guanxiang_propose_skill')
    const signal = new AbortController().signal
    const step = (depth?: number) => ({ agent: { id: 'a', session: { header: { id: 'a', ...depth === undefined ? {} : { delegationDepth: depth } } } }, signal })
    expect(await propose!.when?.(step())).toBe(true)
    expect(await propose!.when?.(step(1))).toBe(false)
    const [candidate] = await h.skills[0]!.list({})
    expect((await h.skills[0]!.get(candidate!, {}))?.content).toContain('`guanxiang_propose_skill`')
  })

  it('refreshes repositories before rendering /guanxiang, waiting at most refreshWaitMs', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    const origin = await createAppRepo(join(dir, 'order-service'))
    const manifestPath = join(origin, '.dsh', 'guanxiang.yaml')
    const addHint = async (hint: string): Promise<void> => {
      await commitFile(origin, '.dsh/guanxiang.yaml', (await readFile(manifestPath, 'utf8')).replace('logHints: [', `logHints: [${hint}, `))
    }
    const stalled = { value: false }
    const git: GitRunner = (args, options) => stalled.value && args[0] === 'fetch' ? new Promise(() => {}) : runGit(args, options)
    const h = await harness()
    cleanups.push(h.dispose)
    apply(h.ctx, { reposDir: join(dir, 'repos'), repos: [{ url: origin }], refreshWaitMs: 200 }, { overlayPath: join(dir, 'settings.json'), git })
    const provider = h.skills[0]!
    const [candidate] = await provider.list({})
    expect((await provider.get(candidate!, {}))?.content).not.toContain('PushedHint')

    await addHint('PushedHint')
    expect((await provider.get(candidate!, {}))?.content).toContain('`PushedHint`')

    stalled.value = true
    await addHint('LateHint')
    const started = Date.now()
    const content = (await provider.get(candidate!, {}))?.content
    expect(Date.now() - started).toBeLessThan(5000)
    expect(content).toContain('`PushedHint`')
    expect(content).not.toContain('LateHint')
    await expect(provider.get(candidate!, { signal: AbortSignal.abort(new Error('stop')) })).rejects.toThrow('stop')
  })

  it('offers the entry skill to the model outside the repositories unless autoInvoke is off', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    const origin = await createAppRepo(join(dir, 'order-service'))
    const reposDir = join(dir, 'repos')
    for (const autoInvoke of [true, false]) {
      const h = await harness()
      cleanups.push(h.dispose)
      apply(h.ctx, { reposDir, repos: [{ url: origin }], autoInvoke }, { overlayPath: join(dir, `settings-${autoInvoke}.json`) })
      const provider = h.skills[0]!
      const [candidate] = await provider.list({ cwd: dir })
      await provider.get(candidate!, {})
      const [listed] = await provider.list({ cwd: dir })
      expect(listed?.invocation.modelInvocable).toBe(autoInvoke)
      if (autoInvoke) expect(listed?.description).toContain('订单服务（order-service')
      expect(await provider.list({ cwd: join(reposDir, '.snapshots', 'order-service', 'x') })).toEqual([])
    }
  })

  it('serves the panel state and persists only overridden settings', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    const origin = await createAppRepo(join(dir, 'order-service'))
    const overlayPath = join(dir, 'settings.json')
    const h = await harness()
    cleanups.push(h.dispose)
    apply(h.ctx, { reposDir: join(dir, 'repos') }, { overlayPath })
    const initial = await json<StateWire>(await fetch(`${h.base}/guanxiang/state`))
    expect(initial).toMatchObject({ repos: [], overridden: [] })

    const saved = await fetch(`${h.base}/guanxiang/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...initial.settings, repos: [{ url: origin }], download: { ...initial.settings.download, allowedHosts: ['OSS.example.com'] } }),
    })
    expect(saved.status).toBe(200)
    const state = (await json<{ ok: true; state: StateWire }>(saved)).state
    expect(state.overridden).toEqual(['repos', 'download'])
    expect(JSON.parse(await readFile(overlayPath, 'utf8'))).toEqual({ repos: [{ url: origin }], download: { ...initial.settings.download, allowedHosts: ['oss.example.com'] } })
    const step = { agent: { id: 'a', session: { header: { id: 'a' } } }, signal: new AbortController().signal }
    expect(await h.tools[0]!.when?.(step)).toBe(false)
    await waitFor(async () => await h.tools[0]!.when?.(step) === true)

    const invalid = await fetch(`${h.base}/guanxiang/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...initial.settings, maxAppsPerRequest: 0 }) })
    expect(invalid.status).toBe(400)
    expect((await json<{ error: string }>(invalid)).error).toMatch(/^maxAppsPerRequest: /)

    const crossSite = await fetch(`${h.base}/guanxiang/sync`, { method: 'POST', headers: { origin: 'https://evil.example' } })
    expect(crossSite.status).toBe(403)
    const unknown = await fetch(`${h.base}/guanxiang/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: '/nope' }) })
    expect(unknown.status).toBe(400)
    expect((await fetch(`${h.base}/guanxiang/state`, { method: 'POST' })).status).toBe(405)

    const reset = await fetch(`${h.base}/guanxiang/settings`, { method: 'DELETE' })
    expect((await json<{ state: StateWire }>(reset)).state).toMatchObject({ repos: [], overridden: [] })
    expect(await h.tools[0]!.when?.(step)).toBe(false)
  })

  it('pulls https repositories with a token stored through the panel without exposing it', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    const work = await createAppRepo(join(dir, 'order-service'))
    await mkdir(join(dir, 'served'))
    git(dir, 'clone', '-q', '--bare', work, join(dir, 'served', 'order-service.git'))
    const token = 'glpat-Secret0123456789'
    const server = await serveGitOverHttp(join(dir, 'served'), 'oauth2', token)
    cleanups.push(server.close)
    const stored = new Map<string, string>()
    const credentials: HostCredentials = {
      resolve: async (ref) => { const value = stored.get(ref); return value === undefined ? undefined : { value, source: 'file' } },
      describe: async ref => stored.has(ref) ? { configured: true, source: 'file', writable: true } : { configured: false, writable: true },
      set: async (ref, value) => { stored.set(ref, value) },
      unset: async (ref) => { stored.delete(ref) },
    }
    const h = await harness({ credentials })
    cleanups.push(h.dispose)
    const reposDir = join(dir, 'repos')
    const url = `${server.base}/order-service.git`
    apply(h.ctx, { reposDir, repos: [{ url }], gitCredentials: [{ url: `${server.base}/`, tokenEnv: 'GITLAB_TOKEN' }] }, { overlayPath: join(dir, 'settings.json') })
    const state = async (): Promise<StateWire> => await json<StateWire>(await fetch(`${h.base}/guanxiang/state`))
    const putToken = (body: unknown): Promise<Response> => fetch(`${h.base}/guanxiang/token`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

    await waitFor(async () => (await state()).repos[0]?.phase === 'failed')
    const initial = await state()
    expect(initial.settings.gitCredentials).toEqual([{ url: server.base, username: 'oauth2', tokenEnv: 'GITLAB_TOKEN' }])
    expect(initial.repos[0]?.error).toContain('GITLAB_TOKEN 未设置')
    expect(initial.credentials).toEqual({ available: true, tokens: [{ tokenEnv: 'GITLAB_TOKEN', configured: false, writable: true }] })

    const unrelated = await putToken({ tokenEnv: 'DEEPSEEK_API_KEY', value: 'sk-x' })
    expect(unrelated.status).toBe(400)
    expect((await putToken({ tokenEnv: 'GITLAB_TOKEN', value: 'a\nb' })).status).toBe(400)
    expect(stored.size).toBe(0)

    expect((await putToken({ tokenEnv: 'GITLAB_TOKEN', value: 'glpat-wrong' })).status).toBe(200)
    await waitFor(async () => { const repo = (await state()).repos[0]; return repo?.phase === 'failed' && repo.error?.includes('未设置') === false })
    expect((await state()).repos[0]?.error).not.toContain('glpat-wrong')

    const saved = await putToken({ tokenEnv: 'GITLAB_TOKEN', value: ` ${token} ` })
    const savedText = await saved.text()
    expect(saved.status).toBe(200)
    expect(savedText).not.toContain(token)
    // The mutation response already shows the retry, so the panel keeps polling.
    expect((JSON.parse(savedText) as { state: StateWire }).state.repos[0]?.phase).toBe('syncing')
    expect(stored.get('GITLAB_TOKEN')).toBe(token)
    await waitFor(async () => (await state()).repos[0]?.available === true)
    const ready = await state()
    expect(ready.credentials.tokens).toEqual([{ tokenEnv: 'GITLAB_TOKEN', configured: true, source: 'file', writable: true }])
    expect(JSON.stringify(ready)).not.toContain(token)
    expect(await readFile(join(reposDir, 'order-service', '.git', 'config'), 'utf8')).not.toContain(token)

    const cleared = await fetch(`${h.base}/guanxiang/token`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tokenEnv: 'GITLAB_TOKEN' }) })
    expect(cleared.status).toBe(200)
    expect(stored.size).toBe(0)
  })

  it('reports a missing credential store instead of pulling without the token', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    const h = await harness()
    cleanups.push(h.dispose)
    apply(h.ctx, { reposDir: join(dir, 'repos'), repos: [{ url: 'https://gitlab.invalid/team/app.git' }], gitCredentials: [{ url: 'https://gitlab.invalid', tokenEnv: 'GITLAB_TOKEN' }] }, { overlayPath: join(dir, 'settings.json') })
    const state = async (): Promise<StateWire> => await json<StateWire>(await fetch(`${h.base}/guanxiang/state`))
    await waitFor(async () => (await state()).repos[0]?.phase === 'failed')
    const current = await state()
    expect(current.credentials).toEqual({ available: false, tokens: [] })
    expect(current.repos[0]?.error).toContain('没有凭据服务')
    const put = await fetch(`${h.base}/guanxiang/token`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tokenEnv: 'GITLAB_TOKEN', value: 'x' }) })
    expect(put.status).toBe(400)
  })

  it('answers the host gate rejection before touching the request', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    const h = await harness()
    cleanups.push(h.dispose)
    apply(h.ctx, { reposDir: join(dir, 'repos') }, { overlayPath: join(dir, 'settings.json') })
    h.rejection.value = 401
    const response = await fetch(`${h.base}/guanxiang/state`)
    expect(response.status).toBe(401)
  })

  it('reports an invalid overlay file instead of applying it', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    const overlayPath = join(dir, 'settings.json')
    await import('node:fs/promises').then(fs => fs.writeFile(overlayPath, '{"maxAppsPerRequest": "many"}'))
    const h = await harness()
    cleanups.push(h.dispose)
    apply(h.ctx, { reposDir: join(dir, 'repos') }, { overlayPath })
    await waitFor(() => false, 50).catch(() => undefined)
    const state = await json<StateWire>(await fetch(`${h.base}/guanxiang/state`))
    expect(state.overlayError).toContain('内容不合法')
    expect(state.settings.maxAppsPerRequest).toBe(4)
  })
})
