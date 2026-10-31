import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { DshRepos, MirrorState, MirrorTreeEntry, SnapshotLease } from '../src/repos/contract.ts'

const run = promisify(execFile)

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run('git', args, { cwd, encoding: 'utf8' })).stdout
}

async function exists(path: string): Promise<boolean> {
  return await access(path).then(() => true, () => false)
}

/**
 * A rejection in the form `dshRepos` uses.
 * @param code - failure class.
 * @param message - readable reason.
 * @returns the error.
 */
export function repoError(code: string, message: string): Error {
  return Object.assign(new Error(message), { name: 'RepoError', code })
}

/**
 * A local stand-in for the `dshRepos` service: bare git mirrors and worktree
 * snapshots under `root`, with switches for host changes, stalled fetches, and
 * snapshot failures. Code-host calls reject unless a test replaces them.
 */
export class FakeRepos implements DshRepos {
  readonly version = 1 as const
  /** While true, `syncMirror` never settles. */
  stalled = false
  /** When set, `acquireSnapshot` rejects with it. */
  snapshotError: Error | undefined
  private readonly listeners = new Set<() => void>()
  private readonly holders = new Map<string, number>()

  /** @param root - directory for mirrors and snapshots. */
  constructor(readonly root: string) {}

  mirrorSettings(): { dir: string } {
    return { dir: this.root }
  }

  onHostsChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Report a host or token change to every observer. */
  emitHostsChange(): void {
    for (const listener of this.listeners) listener()
  }

  /** @returns the number of snapshot leases not yet released. */
  heldSnapshots(): number {
    return [...this.holders.values()].reduce((sum, count) => sum + count, 0)
  }

  /**
   * @param url - repository address.
   * @returns the mirror directory of the address.
   */
  mirrorDir(url: string): string {
    return join(this.root, `${basename(url)}-${createHash('sha256').update(url).digest('hex').slice(0, 8)}`)
  }

  async syncMirror(url: string, options: { readonly branch?: string } = {}): Promise<MirrorState> {
    if (this.stalled) return await new Promise(() => {})
    const dir = this.mirrorDir(url)
    try {
      if (await exists(dir)) await git(dir, 'fetch', '-q', '--prune', 'origin', '+refs/heads/*:refs/heads/*')
      else {
        await mkdir(this.root, { recursive: true })
        await git(this.root, 'clone', '-q', '--bare', url, dir)
      }
    } catch (error) {
      throw repoError('unavailable', `同步镜像失败：${(error as Error).message}`)
    }
    const branch = options.branch ?? (await git(dir, 'symbolic-ref', '--short', 'HEAD')).trim()
    let commit: string
    try {
      commit = (await git(dir, 'rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`)).trim()
    } catch {
      throw repoError('not-found', `分支 ${branch} 不存在`)
    }
    const commitTime = (await git(dir, 'show', '-s', '--format=%cI', commit)).trim()
    return { dir, branch, commit, commitTime }
  }

  async readMirrorFile(url: string, commit: string, path: string): Promise<string | undefined> {
    const [entry] = await this.tree(url, commit, path, false)
    if (entry === undefined) return undefined
    if (entry.type !== 'file') throw repoError('invalid', `${path} 不是普通文件`)
    return await git(this.mirrorDir(url), 'cat-file', 'blob', `${commit}:${path}`)
  }

  async listMirrorTree(url: string, commit: string, path: string): Promise<readonly MirrorTreeEntry[]> {
    return (await this.tree(url, commit, path, true)).filter(entry => entry.path !== path)
  }

  async acquireSnapshot(url: string, commit: string): Promise<SnapshotLease> {
    if (this.snapshotError !== undefined) throw this.snapshotError
    const dir = join(this.root, '.snapshots', basename(this.mirrorDir(url)), commit.slice(0, 12))
    if (!await exists(dir)) {
      await mkdir(dirname(dir), { recursive: true })
      await git(this.mirrorDir(url), 'worktree', 'add', '-q', '--detach', dir, commit)
    }
    this.holders.set(dir, (this.holders.get(dir) ?? 0) + 1)
    let released = false
    return {
      dir,
      release: () => {
        if (released) throw new Error(`snapshot ${dir} released twice`)
        released = true
        this.holders.set(dir, (this.holders.get(dir) ?? 1) - 1)
      },
    }
  }

  async getBranch(): Promise<object | undefined> {
    throw repoError('unavailable', 'getBranch is not set up in this test')
  }

  async commitFiles(): Promise<unknown> {
    throw repoError('unavailable', 'commitFiles is not set up in this test')
  }

  async createChange(): Promise<{ readonly webUrl: string }> {
    throw repoError('unavailable', 'createChange is not set up in this test')
  }

  private async tree(url: string, commit: string, path: string, recursive: boolean): Promise<MirrorTreeEntry[]> {
    const output = await git(this.mirrorDir(url), 'ls-tree', '-z', ...recursive ? ['-r', '-t'] : [], commit, '--', path)
    return output.split('\0').filter(line => line !== '').map((line) => {
      const [meta = '', entryPath = ''] = line.split('\t')
      const [mode, type] = meta.split(' ')
      return { path: entryPath, type: mode === '120000' ? 'symlink' : mode === '160000' ? 'submodule' : type === 'tree' ? 'dir' : 'file' }
    })
  }
}
