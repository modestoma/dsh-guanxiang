import { access, mkdir, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runGit } from '../src/repos/git.ts'
import { assignDirs, repoDirName, RepoRegistry } from '../src/repos/registry.ts'
import { MANIFEST_PATH } from '../src/repos/manifest.ts'
import { commitFile, createAppRepo, git, tempDir, waitFor } from './helpers.ts'

const cleanups: (() => Promise<void>)[] = []
const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false)
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
    expect(status?.error).toMatch(/^更新失败，继续使用已有提交 [0-9a-f]{8}：/)
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

  it('updates the catalog while a lease holds an unchanged snapshot, then deletes the old snapshot', async () => {
    const { root, registry } = await setup()
    const origin = await createAppRepo(join(root, 'origin'))
    registry.configure(join(root, 'repos'), [{ url: origin }])
    await registry.syncAll()
    const first = registry.status()[0]?.commit as string

    const lease = await registry.acquire(['order-service'])
    const held = lease.apps.get('order-service')
    expect(held).toMatchObject({ commit: first, url: origin })
    expect(held?.dir.startsWith(join(root, 'repos', '.snapshots', 'origin'))).toBe(true)
    expect(git(held!.dir, 'rev-parse', 'HEAD').trim()).toBe(first)
    expect(registry.status()[0]?.activeRuns).toBe(1)

    const manifest = (await readFile(join(origin, MANIFEST_PATH), 'utf8')).replace('logHints: [', 'logHints: [NewHint, ')
    const head = await commitFile(origin, MANIFEST_PATH, manifest)
    await registry.syncAll()
    expect(registry.status()[0]).toMatchObject({ commit: head, activeRuns: 1 })
    expect(registry.readyApps()[0]?.app.logHints).toContain('NewHint')
    expect(await readFile(join(held!.dir, MANIFEST_PATH), 'utf8')).not.toContain('NewHint')

    const next = await registry.acquire(['order-service'])
    expect(next.apps.get('order-service')?.commit).toBe(head)
    expect(next.apps.get('order-service')?.dir).not.toBe(held?.dir)
    lease.release()
    lease.release()
    await waitFor(async () => !await exists(held!.dir))
    expect(registry.status()[0]?.activeRuns).toBe(1)
    next.release()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(await exists(next.apps.get('order-service')!.dir)).toBe(true)
    const again = await registry.acquire(['order-service'])
    expect(again.apps.get('order-service')?.dir).toBe(next.apps.get('order-service')?.dir)
    again.release()
  })

  it('clones without a working tree and clears snapshots left by an earlier run', async () => {
    const { root, registry } = await setup()
    const origin = await createAppRepo(join(root, 'origin'))
    registry.configure(join(root, 'repos'), [{ url: origin }])
    await registry.syncAll()
    expect(await readdir(join(root, 'repos', 'origin'))).toEqual(['.git'])
    const lease = await registry.acquire(['order-service'])
    const leftover = lease.apps.get('order-service')!.dir

    const restarted = new RepoRegistry({ git: runGit, gitTimeoutMs: 30_000, onChange: () => {} })
    restarted.configure(join(root, 'repos'), [{ url: origin }])
    await restarted.syncAll()
    expect(await exists(leftover)).toBe(false)
    expect(git(join(root, 'repos', 'origin'), 'worktree', 'list', '--porcelain')).not.toContain(leftover)
    const fresh = await restarted.acquire(['order-service'])
    expect(await readFile(join(fresh.apps.get('order-service')!.dir, MANIFEST_PATH), 'utf8')).toContain('order-service')
    fresh.release()
  })

  it('refreshes only repositories whose last sync is old enough', async () => {
    const { root, registry, now } = await setup()
    const origin = await createAppRepo(join(root, 'origin'))
    registry.configure(join(root, 'repos'), [{ url: origin }])
    await registry.refresh(60_000)
    const first = registry.status()[0]?.commit
    expect(first).toBeDefined()
    const head = await commitFile(origin, 'NOTES.md', 'v2\n')
    now.value += 30_000
    await registry.refresh(60_000)
    expect(registry.status()[0]?.commit).toBe(first)
    await registry.refresh(0)
    expect(registry.status()[0]?.commit).toBe(head)
  })

  it('reports a manifest that is a symbolic link as unreadable', async () => {
    const { root, registry } = await setup()
    const origin = await createAppRepo(join(root, 'origin'))
    await rename(join(origin, MANIFEST_PATH), join(origin, '.dsh', 'real.yaml'))
    await symlink('real.yaml', join(origin, MANIFEST_PATH))
    git(origin, 'add', '-A')
    git(origin, 'commit', '-qm', 'link')
    registry.configure(join(root, 'repos'), [{ url: origin }])
    await registry.syncAll()
    expect(registry.status()[0]).toMatchObject({ phase: 'failed', error: `无法读取 ${MANIFEST_PATH}：${MANIFEST_PATH} 不是普通文件` })
  })

  it('releases every application when a snapshot cannot be created', async () => {
    const { root, registry } = await setup()
    const origin = await createAppRepo(join(root, 'origin'))
    registry.configure(join(root, 'repos'), [{ url: origin }])
    await registry.syncAll()
    await writeFile(join(root, 'repos', '.snapshots'), 'not a directory')
    await expect(registry.acquire(['order-service'])).rejects.toThrow('应用「order-service」的代码快照创建失败')
    expect(registry.status()[0]?.activeRuns).toBe(0)
    await rm(join(root, 'repos', '.snapshots'))
    const lease = await registry.acquire(['order-service'])
    expect(await exists(lease.apps.get('order-service')!.dir)).toBe(true)
    lease.release()
  })

  it('rejects unknown application ids with the available ones', async () => {
    const { root, registry } = await setup()
    const origin = await createAppRepo(join(root, 'origin'))
    registry.configure(join(root, 'repos'), [{ url: origin }])
    await registry.syncAll()
    await expect(registry.acquire(['pay-service'])).rejects.toThrow('「pay-service」不在应用注册表中。可用的应用 id：order-service')
    expect(registry.status()[0]?.activeRuns).toBe(0)
  })
})
