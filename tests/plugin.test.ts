import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'
import type { HostContext, SkillProvider, SkillProviderControl, ToolActivationContext, ToolDefinition } from '../src/host.ts'
import type { StateWire } from '../src/settings/contract.ts'
import { runGit } from '../src/repos/git.ts'
import type { GitRunner } from '../src/repos/git.ts'
import { commitFile, createAppRepo, tempDir, waitFor } from './helpers.ts'

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

async function harness(): Promise<Harness> {
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
    get: (name: string) => ({ webServer, connection } as Record<string, unknown>)[name],
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
    expect(h.tools.map(tool => tool.definition.name)).toEqual(['guanxiang_dispatch'])
    const [tool] = h.tools
    const signal = new AbortController().signal
    const step = (depth?: number) => ({ agent: { id: 'a', session: { header: { id: 'a', ...depth === undefined ? {} : { delegationDepth: depth } } } }, signal })
    // The condition waits for the first sync, so a step prepared during startup still sees the cloned application.
    expect(await tool!.when?.(step())).toBe(true)
    expect(await tool!.when?.(step(1))).toBe(false)
    const [candidate] = await h.skills[0]!.list({})
    expect((await h.skills[0]!.get(candidate!, {}))?.content).toContain('`order-service`')
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
