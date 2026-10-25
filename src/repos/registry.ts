/**
 * 应用注册表：把设置中的 git 地址拉取到 `<reposDir>/<仓库名>`，读取各仓库的
 * 应用描述，并对外提供「已就绪的应用」。
 *
 * - 新地址 `git clone`（先克隆到临时目录再改名，半成品不会被当成仓库）；
 *   已有目录 `git fetch` 后切到远端分支最新提交（detached HEAD）。
 * - 更新失败时继续使用磁盘上已有的检出，并在状态里给出原因；应用描述或
 *   SKILL 不合法时该应用不可用。
 * - 有子 Agent 正在某仓库分析时不更新它，分析结束后补做被推迟的更新。
 * - 多个仓库声明同一个应用 id 时，这些仓库全部不可用。
 *
 * @module dsh-guanxiang/repos/registry
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { expandHome } from '../config.ts'
import type { AppManifest, RepoSpec, RepoStatusWire } from '../settings/contract.ts'
import { GitError } from './git.ts'
import type { GitRunner } from './git.ts'
import { readAppManifest } from './manifest.ts'

/** Collaborators of the registry. */
export interface RepoRegistryDeps {
  readonly git: GitRunner
  /** Timeout of one git command. */
  readonly gitTimeoutMs: number
  /** Called after any status change (sync start/end, configuration, leases). */
  readonly onChange: () => void
  readonly now?: () => number
}

/** A usable application and its checkout. */
export interface ReadyApp {
  readonly app: AppManifest
  readonly dir: string
  readonly url: string
  readonly commit: string
}

/** Held checkouts of one dispatch; release exactly once. */
export interface RepoLease {
  readonly apps: ReadonlyMap<string, ReadyApp>
  release(): void
}

interface RepoEntry {
  readonly spec: RepoSpec
  readonly dir: string
  commit?: string
  commitTime?: string
  app?: AppManifest
  error?: string
  syncedAt?: number
  syncing?: Promise<void>
  activeRuns: number
  /** A sync was skipped while children were running in this checkout. */
  deferred: boolean
  /** Removed from the configuration; kept only until in-flight work settles. */
  retired: boolean
}

/**
 * Checkout directory name for a git address: its last path segment without
 * `.git`, restricted to `[A-Za-z0-9._-]`.
 * @param url - git address.
 * @returns directory name.
 */
export function repoDirName(url: string): string {
  const path = url.replace(/^[^@/]+@[^:/]+:/, '').replace(/[?#].*$/, '').replace(/\/+$/, '')
  const last = path.split(/[/\\:]/).pop() ?? ''
  const name = last.replace(/\.git$/, '').replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '')
  return name === '' ? 'repo' : name
}

/**
 * Assign each address a distinct directory; colliding names get a short hash
 * of their address appended.
 * @param reposDir - parent directory (may start with `~`).
 * @param urls - configured addresses.
 * @returns absolute directory per address.
 */
export function assignDirs(reposDir: string, urls: readonly string[]): Map<string, string> {
  const root = expandHome(reposDir)
  const counts = new Map<string, number>()
  for (const url of urls) counts.set(repoDirName(url), (counts.get(repoDirName(url)) ?? 0) + 1)
  const dirs = new Map<string, string>()
  for (const url of urls) {
    const name = repoDirName(url)
    const unique = (counts.get(name) ?? 0) > 1
      ? `${name}-${createHash('sha1').update(url).digest('hex').slice(0, 8)}`
      : name
    dirs.set(url, join(root, unique))
  }
  return dirs
}

function messageOf(error: unknown): string {
  if (error instanceof GitError) return error.output === '' ? error.message : error.output
  return error instanceof Error ? error.message : String(error)
}

async function pathKind(path: string): Promise<'missing' | 'directory' | 'other'> {
  try {
    return (await stat(path)).isDirectory() ? 'directory' : 'other'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }
}

/** Clones, updates, and indexes the configured application repositories. */
export class RepoRegistry {
  private entries: RepoEntry[] = []
  private readonly dirLocks = new Map<string, Promise<void>>()
  private readonly now: () => number

  /** @param deps - git runner, timeout, and change notification. */
  constructor(private readonly deps: RepoRegistryDeps) {
    this.now = deps.now ?? Date.now
  }

  /**
   * Replace the configured repositories. An address keeps its status when its
   * branch and directory are unchanged; checkouts of removed addresses stay on
   * disk.
   * @param reposDir - parent directory of the checkouts.
   * @param repos - configured repositories.
   * @returns entries that are new or changed and therefore need a sync.
   */
  configure(reposDir: string, repos: readonly RepoSpec[]): string[] {
    const dirs = assignDirs(reposDir, repos.map(repo => repo.url))
    const previous = new Map(this.entries.map(entry => [entry.spec.url, entry]))
    const changed: string[] = []
    this.entries = repos.map((spec) => {
      const dir = dirs.get(spec.url) as string
      const kept = previous.get(spec.url)
      if (kept !== undefined && kept.dir === dir && kept.spec.branch === spec.branch) {
        previous.delete(spec.url)
        return kept
      }
      changed.push(spec.url)
      return { spec: { ...spec }, dir, activeRuns: 0, deferred: false, retired: false }
    })
    for (const entry of previous.values()) entry.retired = true
    this.deps.onChange()
    return changed
  }

  /**
   * Sync every configured repository, in parallel.
   * @returns when every sync settled (failures are recorded in the status).
   */
  async syncAll(): Promise<void> {
    await Promise.all(this.entries.map(entry => this.syncEntry(entry)))
  }

  /**
   * Sync the configured repositories with the given addresses.
   * @param urls - addresses to sync.
   * @returns when those syncs settled.
   */
  async syncUrls(urls: readonly string[]): Promise<void> {
    const wanted = new Set(urls)
    await Promise.all(this.entries.filter(entry => wanted.has(entry.spec.url)).map(entry => this.syncEntry(entry)))
  }

  /**
   * Whether an address is configured.
   * @param url - git address.
   * @returns whether it is in the current configuration.
   */
  has(url: string): boolean {
    return this.entries.some(entry => entry.spec.url === url)
  }

  /** @returns the panel view of every configured repository. */
  status(): RepoStatusWire[] {
    const duplicates = this.duplicateIds()
    return this.entries.map((entry) => {
      const duplicate = entry.app !== undefined ? duplicates.get(entry.app.id) : undefined
      const conflict = duplicate !== undefined && duplicate.length > 1
        ? `应用 id「${entry.app?.id}」同时出现在 ${duplicate.join('、')}，这些仓库均不可用`
        : undefined
      const phase = entry.syncing !== undefined ? 'syncing' : entry.app !== undefined ? 'ready' : entry.error !== undefined ? 'failed' : 'pending'
      const error = conflict ?? entry.error
      return {
        url: entry.spec.url,
        ...entry.spec.branch === undefined ? {} : { branch: entry.spec.branch },
        dir: entry.dir,
        phase,
        ...entry.commit === undefined ? {} : { commit: entry.commit },
        ...entry.commitTime === undefined ? {} : { commitTime: entry.commitTime },
        ...entry.syncedAt === undefined ? {} : { syncedAt: entry.syncedAt },
        ...entry.app === undefined ? {} : { app: entry.app },
        ...error === undefined ? {} : { error },
        available: entry.app !== undefined && conflict === undefined,
        activeRuns: entry.activeRuns,
      }
    })
  }

  /** @returns usable applications, ordered as configured. */
  readyApps(): ReadyApp[] {
    const duplicates = this.duplicateIds()
    const ready: ReadyApp[] = []
    for (const entry of this.entries) {
      if (entry.app === undefined || entry.commit === undefined) continue
      if ((duplicates.get(entry.app.id)?.length ?? 0) > 1) continue
      ready.push({ app: entry.app, dir: entry.dir, url: entry.spec.url, commit: entry.commit })
    }
    return ready
  }

  /**
   * Hold the checkouts of the requested applications for one dispatch. A
   * checkout older than `fetchIntervalMs` that nobody is using is updated
   * first. Every id must resolve to a usable application, or nothing is held.
   * @param ids - requested application ids (duplicates allowed).
   * @param fetchIntervalMs - staleness threshold.
   * @returns the lease.
   * @throws when an id is unknown or its repository is not usable.
   */
  async acquire(ids: readonly string[], fetchIntervalMs: number): Promise<RepoLease> {
    const unique = [...new Set(ids)]
    const byId = (): Map<string, RepoEntry> => new Map(this.entries.flatMap(entry => entry.app === undefined ? [] : [[entry.app.id, entry] as const]))
    const initial = byId()
    const unknown = unique.filter(id => !initial.has(id))
    if (unknown.length > 0) throw new Error(this.unknownMessage(unknown))
    await Promise.all(unique.map(async (id) => {
      const entry = initial.get(id) as RepoEntry
      if (entry.syncing !== undefined) await entry.syncing
      const stale = entry.syncedAt === undefined || this.now() - entry.syncedAt > fetchIntervalMs
      if (stale && entry.activeRuns === 0) await this.syncEntry(entry)
    }))
    const ready = new Map(this.readyApps().map(app => [app.app.id, app]))
    const missing = unique.filter(id => !ready.has(id))
    if (missing.length > 0) throw new Error(this.unknownMessage(missing))
    const held = unique.map(id => this.entries.find(entry => entry.app?.id === id) as RepoEntry)
    for (const entry of held) entry.activeRuns += 1
    this.deps.onChange()
    let released = false
    return {
      apps: new Map(unique.map(id => [id, ready.get(id) as ReadyApp])),
      release: () => {
        if (released) return
        released = true
        for (const entry of held) {
          entry.activeRuns -= 1
          if (entry.activeRuns === 0 && entry.deferred && !entry.retired) {
            entry.deferred = false
            void this.syncEntry(entry)
          }
        }
        this.deps.onChange()
      },
    }
  }

  private unknownMessage(ids: readonly string[]): string {
    const status = new Map(this.status().flatMap(repo => repo.app === undefined ? [] : [[repo.app.id, repo] as const]))
    const details = ids.map((id) => {
      const repo = status.get(id)
      return repo === undefined ? `「${id}」不在应用注册表中` : `「${id}」不可用：${repo.error ?? repo.phase}`
    })
    const available = this.readyApps().map(app => app.app.id)
    return `${details.join('；')}。可用的应用 id：${available.length === 0 ? '（无）' : available.join('、')}`
  }

  private duplicateIds(): Map<string, string[]> {
    const urls = new Map<string, string[]>()
    for (const entry of this.entries) {
      if (entry.app === undefined) continue
      urls.set(entry.app.id, [...urls.get(entry.app.id) ?? [], entry.spec.url])
    }
    return urls
  }

  private syncEntry(entry: RepoEntry): Promise<void> {
    if (entry.syncing !== undefined) return entry.syncing
    if (entry.activeRuns > 0) {
      entry.deferred = true
      return Promise.resolve()
    }
    const previous = this.dirLocks.get(entry.dir) ?? Promise.resolve()
    const run = previous.then(() => this.runSync(entry)).finally(() => {
      entry.syncing = undefined
      if (this.dirLocks.get(entry.dir) === locked) this.dirLocks.delete(entry.dir)
      this.deps.onChange()
    })
    const locked = run.catch(() => undefined)
    this.dirLocks.set(entry.dir, locked)
    entry.syncing = run
    this.deps.onChange()
    return run
  }

  private async runSync(entry: RepoEntry): Promise<void> {
    if (entry.retired) return
    const hadCheckout = entry.commit !== undefined
    try {
      await this.checkout(entry)
    } catch (error) {
      entry.syncedAt = this.now()
      entry.error = hadCheckout && entry.app !== undefined
        ? `更新失败，继续使用已有检出 ${entry.commit?.slice(0, 8)}：${messageOf(error)}`
        : messageOf(error)
      return
    }
    entry.syncedAt = this.now()
    const manifest = await readAppManifest(entry.dir)
    if (manifest.ok) {
      entry.app = manifest.app
      entry.error = undefined
    } else {
      entry.app = undefined
      entry.error = manifest.error
    }
  }

  private async checkout(entry: RepoEntry): Promise<void> {
    const { git, gitTimeoutMs: timeoutMs } = this.deps
    const { dir, spec } = entry
    const kind = await pathKind(dir)
    if (kind === 'missing') {
      await mkdir(join(dir, '..'), { recursive: true })
      const partial = `${dir}.partial-${randomBytes(4).toString('hex')}`
      try {
        await git(['clone', '--quiet', ...spec.branch === undefined ? [] : ['--branch', spec.branch], '--', spec.url, partial], { timeoutMs })
        await rename(partial, dir)
      } catch (error) {
        await rm(partial, { recursive: true, force: true })
        throw error
      }
    } else {
      if (kind !== 'directory') throw new Error(`${dir} 已存在且不是目录`)
      if (await pathKind(join(dir, '.git')) === 'missing') {
        const empty = (await readdir(dir)).length === 0
        if (!empty) throw new Error(`${dir} 已存在且不是 git 仓库，请移走后重新拉取`)
        await rm(dir, { recursive: true })
        await this.checkout(entry)
        return
      }
      const origin = (await git(['remote', 'get-url', 'origin'], { cwd: dir, timeoutMs })).trim()
      if (origin !== spec.url) throw new Error(`${dir} 已被另一个仓库占用（origin 为 ${origin}）`)
      await git(['fetch', '--quiet', '--prune', 'origin'], { cwd: dir, timeoutMs })
      const target = spec.branch === undefined ? await this.remoteHead(dir) : `refs/remotes/origin/${spec.branch}`
      await git(['checkout', '--quiet', '--force', '--detach', target], { cwd: dir, timeoutMs })
    }
    const [commit = '', commitTime = ''] = (await git(['log', '-1', '--format=%H%n%cI'], { cwd: dir, timeoutMs })).trim().split('\n')
    entry.commit = commit
    entry.commitTime = commitTime
  }

  private async remoteHead(dir: string): Promise<string> {
    const { git, gitTimeoutMs: timeoutMs } = this.deps
    const read = async (): Promise<string> => (await git(['symbolic-ref', 'refs/remotes/origin/HEAD'], { cwd: dir, timeoutMs })).trim()
    try {
      return await read()
    } catch (error) {
      if (!(error instanceof GitError)) throw error
      await git(['remote', 'set-head', 'origin', '--auto'], { cwd: dir, timeoutMs })
      return await read()
    }
  }
}
