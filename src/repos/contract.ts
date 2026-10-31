/**
 * 观象对 `dshRepos` 服务（version 1）的需求：只声明观象调用的方法和读取的
 * 字段。服务在运行时经 `ctx.get('dshRepos')` 取得，由任何按这一约定提供该服务
 * 的插件实现；观象不依赖提供方的包。
 *
 * 每个方法在预期内的失败时以 `name` 为 `RepoError`、带字符串 `code` 的错误
 * 拒绝（`conflict` 表示分支已存在）。
 *
 * @module dsh-logalyze/repos/contract
 */

/** The `dshRepos` service version this plugin calls. */
export type DshReposVersion = 1

/** Options every call accepts. */
export interface CallOptions {
  /** Aborting stops waiting; a write may still have reached the code host. */
  readonly signal?: AbortSignal
}

/** Where the provider keeps local mirrors. */
export interface MirrorSettings {
  /** Absolute directory holding the mirrors and the snapshots. */
  readonly dir: string
}

/** A mirror after a successful clone or fetch. */
export interface MirrorState {
  /** Absolute directory of the fetch-only mirror. */
  readonly dir: string
  /** The requested branch, or the remote's default branch. */
  readonly branch: string
  /** Full commit id the branch points to after the fetch. */
  readonly commit: string
  /** Committer date of {@link commit}, ISO 8601. */
  readonly commitTime: string
}

/** One entry of a mirror tree listing. */
export interface MirrorTreeEntry {
  /** Path from the repository root, `/`-separated. */
  readonly path: string
  readonly type: 'file' | 'dir' | 'symlink' | 'submodule'
}

/**
 * A read-only checkout of one commit. The directory stays unchanged until
 * released; release exactly once.
 */
export interface SnapshotLease {
  /** Absolute directory of the checkout. */
  readonly dir: string
  release(): void
}

/** Name and email recorded as a commit's author. */
export interface CommitAuthor {
  readonly name: string
  readonly email: string
}

/** A multi-file commit on a new branch. */
export interface CommitRequest extends CallOptions {
  readonly branch: string
  /** Full commit id the new branch starts from. */
  readonly baseSha: string
  /** True: fail with `conflict` instead of committing onto an existing branch. */
  readonly newBranch: true
  /** Commit author; default: the token's user. */
  readonly author?: CommitAuthor
  readonly message: string
  readonly files: readonly { readonly action: 'write'; readonly path: string; readonly content: string }[]
}

/** Fields of a new pull or merge request. */
export interface ChangeCreate extends CallOptions {
  readonly title: string
  readonly body: string
  readonly sourceBranch: string
  readonly targetBranch: string
}

/** The `dshRepos` methods this plugin calls. */
export interface DshRepos {
  readonly version: DshReposVersion
  /** @returns where mirrors and snapshots live. */
  mirrorSettings(): MirrorSettings
  /**
   * Observe host or token changes that can change what a sync can reach.
   * @param listener - runs after each change.
   * @returns disposer that stops the observation.
   */
  onHostsChange(listener: () => void): () => void
  /**
   * Clone the address as a fetch-only mirror, or fetch it, and resolve the branch head.
   * @param url - git address as configured.
   * @returns the mirror and the branch head.
   */
  syncMirror(url: string, options?: CallOptions & { readonly branch?: string }): Promise<MirrorState>
  /**
   * Read one regular file of a fetched commit.
   * @returns UTF-8 text, or undefined when the commit has no such path.
   * @throws when the path is not a regular file.
   */
  readMirrorFile(url: string, commit: string, path: string, options?: CallOptions): Promise<string | undefined>
  /**
   * List the entries below a directory of a fetched commit, recursively.
   * @returns entries, or an empty list when the path does not exist.
   */
  listMirrorTree(url: string, commit: string, path: string, options?: CallOptions): Promise<readonly MirrorTreeEntry[]>
  /** @returns a held read-only checkout of the commit. */
  acquireSnapshot(url: string, commit: string, options?: CallOptions): Promise<SnapshotLease>
  /** @returns the branch, or undefined when the repository has no branch of that name. */
  getBranch(repo: string, name: string, options?: CallOptions): Promise<object | undefined>
  /** @returns once the commit exists on the new branch. */
  commitFiles(repo: string, request: CommitRequest): Promise<unknown>
  /** @returns the new pull or merge request. */
  createChange(repo: string, change: ChangeCreate): Promise<{ readonly webUrl: string }>
}
