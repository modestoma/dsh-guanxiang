/**
 * 应用注册表：把设置中的 git 地址拉取到 `<reposDir>/<仓库名>`，从远端分支最新
 * 提交读取各仓库的应用描述，对外提供「已就绪的应用」，并为每次派发提供该
 * 提交的只读代码快照。
 *
 * - 拉取目录只做 fetch，不检出：新地址 `git clone --no-checkout`（先克隆到临时
 *   目录再改名，半成品不会被当成仓库），已有目录 `git fetch`。应用描述与 SKILL
 *   直接从提交的 git 对象读取，所以随时可以更新，不受正在进行的分析影响。
 * - 子 Agent 在 `<reposDir>/.snapshots/<仓库名>/` 下按提交创建的 `git worktree`
 *   快照里工作。快照创建后不再改动；同一提交的派发共用一份，没有使用者且已不是
 *   最新提交时删除。进程内首次同步某仓库时清掉上次运行遗留的快照。
 * - 更新失败时继续使用已有提交，并在状态里给出原因；应用描述或 SKILL 不合法时
 *   该应用不可用。
 * - 多个仓库声明同一个应用 id 时，这些仓库全部不可用。
 *
 * @module dsh-guanxiang/repos/registry
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { expandHome } from '../config.ts'
import type { AppManifest, RepoSpec, RepoStatusWire } from '../settings/contract.ts'
import { GitError } from './git.ts'
import type { GitRunner } from './git.ts'
import { checkAppManifest } from './manifest.ts'
import type { RepoFileReader } from './manifest.ts'

/** Collaborators of the registry. */
export interface RepoRegistryDeps {
  readonly git: GitRunner
  /** Timeout of one git command. */
  readonly gitTimeoutMs: number
  /**
   * Environment for the network commands (clone, fetch, remote HEAD lookup) of
   * one address, such as an access token; resolved again on every sync. A
   * rejection fails that sync with its message.
   */
  readonly auth?: (url: string) => Promise<Readonly<Record<string, string>>>
  /** Called after any status change (sync start/end, configuration, leases). */
  readonly onChange: () => void
  readonly now?: () => number
}

/** A usable application at its latest synced commit. */
export interface ReadyApp {
  readonly app: AppManifest
  readonly url: string
  readonly commit: string
}

/** An application held by one dispatch, with the snapshot its child works in. */
export interface LeasedApp extends ReadyApp {
  /** Read-only checkout of {@link ReadyApp.commit}; unchanged until the lease is released. */
  readonly dir: string
}

/** A clone opened for writing objects; see {@link RepoRegistry.withClone}. */
export interface CloneAccess {
  /** Fetch-only clone directory. */
  readonly dir: string
  /** The configured branch, or the remote's default branch when none is configured. */
  readonly branch: string
}

/** Held snapshots of one dispatch; release exactly once. */
export interface RepoLease {
  readonly apps: ReadonlyMap<string, LeasedApp>
  release(): void
}

interface Snapshot {
  readonly commit: string
  readonly dir: string
  /** Leases holding this snapshot. */
  users: number
  /** Settles once `git worktree add` finished; rejects when it failed. */
  readonly created: Promise<void>
}

interface RepoEntry {
  readonly spec: RepoSpec
  /** Fetch-only clone. */
  readonly dir: string
  commit?: string
  commitTime?: string
  app?: AppManifest
  error?: string
  syncedAt?: number
  syncing?: Promise<void>
  /** Snapshots by commit. */
  readonly snapshots: Map<string, Snapshot>
  activeRuns: number
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

/**
 * Directory holding the commit snapshots of one clone.
 * @param dir - clone directory `<reposDir>/<name>`.
 * @returns `<reposDir>/.snapshots/<name>`.
 */
export function snapshotRoot(dir: string): string {
  return join(dirname(dir), '.snapshots', basename(dir))
}

/**
 * Run a task after every task queued earlier under the same key.
 * @param locks - tail of each key's queue.
 * @param key - queue key.
 * @param task - work to run.
 * @returns the task's result.
 */
function serialize<T>(locks: Map<string, Promise<void>>, key: string, task: () => Promise<T>): Promise<T> {
  const run = (locks.get(key) ?? Promise.resolve()).then(task)
  // The queue only orders work; callers observe the failure through `run`.
  const tail = run.then(() => undefined, () => undefined)
  locks.set(key, tail)
  void tail.then(() => { if (locks.get(key) === tail) locks.delete(key) })
  return run
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
  /** Orders clone and fetch work per clone directory. */
  private readonly syncLocks = new Map<string, Promise<void>>()
  /** Orders `git worktree` work per clone directory. */
  private readonly worktreeLocks = new Map<string, Promise<void>>()
  /** Snapshot roots already cleared of leftovers from an earlier run. */
  private readonly clearedRoots = new Set<string>()
  private readonly now: () => number

  /** @param deps - git runner, timeout, and change notification. */
  constructor(private readonly deps: RepoRegistryDeps) {
    this.now = deps.now ?? Date.now
  }

  /**
   * Replace the configured repositories. An address keeps its status when its
   * branch and directory are unchanged; clones of removed addresses stay on
   * disk, and their snapshots are deleted once no dispatch holds them.
   * @param reposDir - parent directory of the clones.
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
      return { spec: { ...spec }, dir, snapshots: new Map(), activeRuns: 0, retired: false }
    })
    for (const entry of previous.values()) {
      entry.retired = true
      this.pruneSnapshots(entry)
    }
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
   * Sync the configured repositories with the given addresses again after any
   * sync already running for them, so the new sync sees settings changed since
   * that sync started (an access token, for example). An idle repository
   * starts syncing before this returns, so its status reads `syncing` at once.
   * @param urls - addresses to sync.
   * @returns when those syncs settled.
   */
  async resyncUrls(urls: readonly string[]): Promise<void> {
    const wanted = new Set(urls)
    await Promise.all(this.entries.filter(entry => wanted.has(entry.spec.url)).map(entry => entry.syncing === undefined
      ? this.syncEntry(entry)
      // The running sync's outcome is superseded by the one started after it.
      : entry.syncing.then(() => undefined, () => undefined).then(() => this.syncEntry(entry))))
  }

  /**
   * Sync the repositories that never synced or whose last sync is at least
   * `maxAgeMs` old, and join syncs already running.
   * @param maxAgeMs - age threshold; 0 syncs every repository.
   * @returns when those syncs settled.
   */
  async refresh(maxAgeMs: number): Promise<void> {
    const now = this.now()
    await Promise.all(this.entries
      .filter(entry => entry.syncing !== undefined || entry.syncedAt === undefined || now - entry.syncedAt >= maxAgeMs)
      .map(entry => this.syncEntry(entry)))
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
    return this.readyEntries().map(({ ready }) => ready)
  }

  private readyEntries(): { entry: RepoEntry; ready: ReadyApp }[] {
    const duplicates = this.duplicateIds()
    const ready: { entry: RepoEntry; ready: ReadyApp }[] = []
    for (const entry of this.entries) {
      if (entry.app === undefined || entry.commit === undefined) continue
      if ((duplicates.get(entry.app.id)?.length ?? 0) > 1) continue
      ready.push({ entry, ready: { app: entry.app, url: entry.spec.url, commit: entry.commit } })
    }
    return ready
  }

  /**
   * Hold a snapshot of each requested application's latest synced commit for
   * one dispatch, creating the snapshots that do not exist yet. Every id must
   * resolve to a usable application, or nothing is held.
   * @param ids - requested application ids (duplicates allowed).
   * @returns the lease.
   * @throws when an id is unknown, its repository is not usable, or a snapshot cannot be created.
   */
  async acquire(ids: readonly string[]): Promise<RepoLease> {
    const unique = [...new Set(ids)]
    const ready = new Map(this.readyEntries().map(item => [item.ready.app.id, item]))
    const missing = unique.filter(id => !ready.has(id))
    if (missing.length > 0) throw new Error(this.unknownMessage(missing))
    const held = unique.map((id) => {
      const { entry, ready: app } = ready.get(id) as { entry: RepoEntry; ready: ReadyApp }
      const snapshot = this.snapshotFor(entry, app.commit)
      snapshot.users += 1
      entry.activeRuns += 1
      return { id, entry, app, snapshot }
    })
    this.deps.onChange()
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      for (const { entry, snapshot } of held) {
        snapshot.users -= 1
        entry.activeRuns -= 1
      }
      for (const entry of new Set(held.map(item => item.entry))) this.pruneSnapshots(entry)
      this.deps.onChange()
    }
    const created = await Promise.allSettled(held.map(item => item.snapshot.created))
    for (const [index, outcome] of created.entries()) {
      if (outcome.status === 'fulfilled') continue
      release()
      throw new Error(`应用「${held[index]?.id}」的代码快照创建失败：${messageOf(outcome.reason)}`)
    }
    return {
      apps: new Map(held.map(({ id, app, snapshot }) => [id, { ...app, dir: snapshot.dir }])),
      release,
    }
  }

  /**
   * Run a task on the clone of a configured address after every sync queued
   * before it, so the task never overlaps a fetch of the same clone.
   * @param url - configured repository address.
   * @param task - work on the clone.
   * @returns the task's result.
   * @throws when the address is not configured, its token cannot be read, or the task fails.
   */
  async withClone<T>(url: string, task: (clone: CloneAccess) => Promise<T>): Promise<T> {
    const entry = this.entries.find(item => item.spec.url === url)
    if (entry === undefined) throw new Error(`仓库 ${url} 已不在配置中`)
    return await serialize(this.syncLocks, entry.dir, async () => {
      if (entry.retired) throw new Error(`仓库 ${url} 已不在配置中`)
      const env = await this.deps.auth?.(url) ?? {}
      const branch = entry.spec.branch ?? (await this.remoteHead(entry.dir, env)).replace(/^refs\/remotes\/origin\//, '')
      return await task({ dir: entry.dir, branch })
    })
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
    const run = serialize(this.syncLocks, entry.dir, () => this.runSync(entry)).finally(() => {
      entry.syncing = undefined
      this.deps.onChange()
    })
    entry.syncing = run
    this.deps.onChange()
    return run
  }

  private async runSync(entry: RepoEntry): Promise<void> {
    if (entry.retired) return
    let head: { commit: string; commitTime: string }
    try {
      head = await this.update(entry)
    } catch (error) {
      entry.syncedAt = this.now()
      entry.error = entry.commit !== undefined && entry.app !== undefined
        ? `更新失败，继续使用已有提交 ${entry.commit.slice(0, 8)}：${messageOf(error)}`
        : messageOf(error)
      return
    }
    const manifest = await checkAppManifest(this.commitReader(entry.dir, head.commit))
    entry.syncedAt = this.now()
    entry.commit = head.commit
    entry.commitTime = head.commitTime
    if (manifest.ok) {
      entry.app = manifest.app
      entry.error = undefined
    } else {
      entry.app = undefined
      entry.error = manifest.error
    }
    this.pruneSnapshots(entry)
  }

  /**
   * Clone or fetch, and resolve the commit the configured branch points to.
   * The first visit of a snapshot root in this process deletes the snapshots
   * an earlier run left behind.
   */
  private async update(entry: RepoEntry): Promise<{ commit: string; commitTime: string }> {
    const { git, gitTimeoutMs: timeoutMs } = this.deps
    const { dir, spec } = entry
    const root = snapshotRoot(dir)
    const firstVisit = !this.clearedRoots.has(root)
    if (firstVisit) {
      this.clearedRoots.add(root)
      await rm(root, { recursive: true, force: true })
    }
    const env = await this.deps.auth?.(spec.url) ?? {}
    const kind = await pathKind(dir)
    if (kind === 'missing') {
      await mkdir(dirname(dir), { recursive: true })
      const partial = `${dir}.partial-${randomBytes(4).toString('hex')}`
      try {
        await git(['clone', '--quiet', '--no-checkout', ...spec.branch === undefined ? [] : ['--branch', spec.branch], '--', spec.url, partial], { timeoutMs, env })
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
        return await this.update(entry)
      }
      const origin = (await git(['remote', 'get-url', 'origin'], { cwd: dir, timeoutMs })).trim()
      if (origin !== spec.url) throw new Error(`${dir} 已被另一个仓库占用（origin 为 ${origin}）`)
      await git(['fetch', '--quiet', '--prune', 'origin'], { cwd: dir, timeoutMs, env })
      if (firstVisit) await git(['worktree', 'prune'], { cwd: dir, timeoutMs })
    }
    const target = spec.branch === undefined ? await this.remoteHead(dir, env) : `refs/remotes/origin/${spec.branch}`
    const [commit = '', commitTime = ''] = (await git(['log', '-1', '--format=%H%n%cI', target, '--'], { cwd: dir, timeoutMs })).trim().split('\n')
    return { commit, commitTime }
  }

  /**
   * Reader for the files of one commit, from the clone's object database.
   * Only regular files are read; a symbolic link is reported as unreadable.
   */
  private commitReader(dir: string, commit: string): RepoFileReader {
    const { git, gitTimeoutMs: timeoutMs } = this.deps
    return async (path) => {
      const listing = await git(['ls-tree', '-z', commit, '--', path], { cwd: dir, timeoutMs })
      if (listing === '') return undefined
      const [mode, type, object] = listing.slice(0, listing.indexOf('\t')).split(' ')
      if (type !== 'blob' || mode === '120000' || object === undefined) throw new Error(`${path} 不是普通文件`)
      return await git(['cat-file', 'blob', object], { cwd: dir, timeoutMs })
    }
  }

  /** The snapshot of `commit`, created in the background on first use. */
  private snapshotFor(entry: RepoEntry, commit: string): Snapshot {
    const existing = entry.snapshots.get(commit)
    if (existing !== undefined) return existing
    const dir = join(snapshotRoot(entry.dir), `${commit.slice(0, 12)}-${randomBytes(3).toString('hex')}`)
    const created = serialize(this.worktreeLocks, entry.dir, async () => {
      await mkdir(dirname(dir), { recursive: true })
      await this.deps.git(['worktree', 'add', '--detach', dir, commit], { cwd: entry.dir, timeoutMs: this.deps.gitTimeoutMs })
    })
    const snapshot: Snapshot = { commit, dir, users: 0, created }
    entry.snapshots.set(commit, snapshot)
    created.catch(() => {
      // The acquiring dispatch reports the failure; the next one retries.
      if (entry.snapshots.get(commit) === snapshot) entry.snapshots.delete(commit)
      void this.removeSnapshot(entry.dir, dir)
    })
    return snapshot
  }

  /** Delete the snapshots no lease holds, except the latest commit's of a configured repository. */
  private pruneSnapshots(entry: RepoEntry): void {
    for (const [commit, snapshot] of entry.snapshots) {
      if (snapshot.users > 0 || (commit === entry.commit && !entry.retired)) continue
      entry.snapshots.delete(commit)
      void snapshot.created.then(() => this.removeSnapshot(entry.dir, snapshot.dir), () => undefined)
    }
  }

  private async removeSnapshot(clone: string, dir: string): Promise<void> {
    try {
      await serialize(this.worktreeLocks, clone, async () => {
        await rm(dir, { recursive: true, force: true })
        await this.deps.git(['worktree', 'prune'], { cwd: clone, timeoutMs: this.deps.gitTimeoutMs })
      })
    } catch {
      // Best effort: the first sync after the next start deletes leftover snapshots.
    }
  }

  private async remoteHead(dir: string, env: Readonly<Record<string, string>>): Promise<string> {
    const { git, gitTimeoutMs: timeoutMs } = this.deps
    const read = async (): Promise<string> => (await git(['symbolic-ref', 'refs/remotes/origin/HEAD'], { cwd: dir, timeoutMs })).trim()
    try {
      return await read()
    } catch (error) {
      if (!(error instanceof GitError)) throw error
      await git(['remote', 'set-head', 'origin', '--auto'], { cwd: dir, timeoutMs, env })
      return await read()
    }
  }
}
