import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runGit } from '../src/repos/git.ts'
import { assignDirs, repoDirName, RepoRegistry } from '../src/repos/registry.ts'
import { commitFile, createAppRepo, git, tempDir } from './helpers.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

async function setup(): Promise<{ root: string; registry: RepoRegistry; changes: () => number; now: { value: number } }> {
  const { dir, cleanup } = await tempDir()
  cleanups.push(cleanup)
  let changes = 0
  const now = { value: 1_000_000 }
  const registry = new RepoRegistry({ git: runGit, gitTimeoutMs: 30_000, onChange: () => { changes += 1 }, now: () => now.value })
  return { root: dir, registry, changes: () => changes, now }
}

describe('checkout directory names', () => {
  it('derives the name from the last path segment', () => {
    expect(repoDirName('git@github.com:example/order-service.git')).toBe('order-service')
    expect(repoDirName('https://github.com/example/pay-service.git/')).toBe('pay-service')
    expect(repoDirName('/srv/git/my app')).toBe('my-app')
    expect(repoDirName('https://host/')).toBe('host')
  })

  it('disambiguates colliding names with a hash of the address', () => {
    const dirs = assignDirs('/r', ['git@a.com:x/app.git', 'git@b.com:y/app.git', 'git@c.com:z/other.git'])
    expect(dirs.get('git@c.com:z/other.git')).toBe('/r/other')
    const a = dirs.get('git@a.com:x/app.git') as string
    const b = dirs.get('git@b.com:y/app.git') as string
    expect(a).toMatch(/^\/r\/app-[0-9a-f]{8}$/)
    expect(b).toMatch(/^\/r\/app-[0-9a-f]{8}$/)
    expect(a).not.toBe(b)
  })
})

describe('repository registry', () => {
  it('clones a repository and exposes its application', async () => {
    const { root, registry } = await setup()
    const origin = await createAppRepo(join(root, 'origin'))
    registry.configure(join(root, 'repos'), [{ url: origin }])
    expect(registry.status()[0]?.phase).toBe('pending')
    await registry.syncAll()
    const [status] = registry.status()
    expect(status).toMatchObject({ url: origin, dir: join(root, 'repos', 'origin'), phase: 'ready', available: true, activeRuns: 0 })
    expect(status?.commit).toBe(git(origin, 'rev-parse', 'HEAD').trim())
    expect(registry.readyApps().map(app => app.app.id)).toEqual(['order-service'])
  })

  it('updates to the remote head and follows a configured branch', async () => {
    const { root, registry, now } = await setup()
    const origin = await createAppRepo(join(root, 'origin'))
    registry.configure(join(root, 'repos'), [{ url: origin }])
    await registry.syncAll()
    const head = await commitFile(origin, 'NOTES.md', 'v2\n')
    now.value += 1
    await registry.syncAll()
    expect(registry.status()[0]?.commit).toBe(head)

    git(origin, 'checkout', '-qb', 'release')
    const release = await commitFile(origin, 'NOTES.md', 'release\n')
    git(origin, 'checkout', '-q', 'main')
    const changed = registry.configure(join(root, 'repos'), [{ url: origin, branch: 'release' }])
    expect(changed).toEqual([origin])
    await registry.syncUrls(changed)
    expect(registry.status()[0]).toMatchObject({ phase: 'ready', branch: 'release', commit: release })
  })

  it('keeps the existing checkout usable when an update fails', async () => {
    const { root, registry } = await setup()
    const origin = await createAppRepo(join(root, 'origin'))
    registry.configure(join(root, 'repos'), [{ url: origin }])
    await registry.syncAll()
    await rm(origin, { recursive: true })
    await registry.syncAll()
    const [status] = registry.status()
    expect(status).toMatchObject({ phase: 'ready', available: true })
    expect(status?.error).toMatch(/^更新失败，继续使用已有检出 [0-9a-f]{8}：/)
  })

  it('marks a repository without a manifest as failed', async () => {
    const { root, registry } = await setup()
    const origin = join(root, 'bare-app')
    await mkdir(origin)
    await writeFile(join(origin, 'README.md'), 'x')
    git(origin, 'init', '-q', '-b', 'main')
    git(origin, 'add', '-A')
    git(origin, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'init')
    registry.configure(join(root, 'repos'), [{ url: origin }])
    await registry.syncAll()
    expect(registry.status()[0]).toMatchObject({ phase: 'failed', available: false, error: '仓库缺少应用描述 .dsh/guanxiang.yaml' })
    expect(registry.readyApps()).toEqual([])
  })

  it('reports clone failures and refuses directories owned by another remote', async () => {
    const { root, registry } = await setup()
    registry.configure(join(root, 'repos'), [{ url: join(root, 'missing') }])
    await registry.syncAll()
    expect(registry.status()[0]).toMatchObject({ phase: 'failed', available: false })
    expect(registry.status()[0]?.error).not.toBe('')

    const first = await createAppRepo(join(root, 'a', 'app'))
    const second = await createAppRepo(join(root, 'b', 'app'))
    registry.configure(join(root, 'repos'), [{ url: first }])
    await registry.syncAll()
    registry.configure(join(root, 'repos'), [{ url: second }])
    await registry.syncAll()
    expect(registry.status()[0]?.error).toContain('已被另一个仓库占用')
  })

  it('makes every repository declaring the same application id unavailable', async () => {
    const { root, registry } = await setup()
    const first = await createAppRepo(join(root, 'one'))
    const second = await createAppRepo(join(root, 'two'))
    registry.configure(join(root, 'repos'), [{ url: first }, { url: second }])
    await registry.syncAll()
    expect(registry.readyApps()).toEqual([])
    expect(registry.status().map(repo => repo.available)).toEqual([false, false])
    expect(registry.status()[0]?.error).toContain('同时出现在')
  })

  it('defers updates while a lease holds the checkout and refreshes stale checkouts on acquire', async () => {
    const { root, registry, now } = await setup()
    const origin = await createAppRepo(join(root, 'origin'))
    registry.configure(join(root, 'repos'), [{ url: origin }])
    await registry.syncAll()
    const first = registry.status()[0]?.commit

    const head = await commitFile(origin, 'NOTES.md', 'v2\n')
    const lease = await registry.acquire(['order-service'], 60_000)
    expect(lease.apps.get('order-service')?.commit).toBe(first)
    expect(registry.status()[0]?.activeRuns).toBe(1)
    await registry.syncAll()
    expect(registry.status()[0]?.commit).toBe(first)
    lease.release()
    lease.release()
    await new Promise(resolve => setTimeout(resolve, 0))
    await registry.syncAll()
    expect(registry.status()[0]).toMatchObject({ commit: head, activeRuns: 0 })

    const next = await commitFile(origin, 'NOTES.md', 'v3\n')
    now.value += 120_000
    const stale = await registry.acquire(['order-service'], 60_000)
    expect(stale.apps.get('order-service')?.commit).toBe(next)
    stale.release()
  })

  it('rejects unknown application ids with the available ones', async () => {
    const { root, registry } = await setup()
    const origin = await createAppRepo(join(root, 'origin'))
    registry.configure(join(root, 'repos'), [{ url: origin }])
    await registry.syncAll()
    await expect(registry.acquire(['pay-service'], 60_000)).rejects.toThrow('「pay-service」不在应用注册表中。可用的应用 id：order-service')
    expect(registry.status()[0]?.activeRuns).toBe(0)
  })
})
