/**
 * dsh-repo `dshRepos` 服务的查找。观象经它维护应用仓库的本地镜像和只读快照、
 * 管理主机与令牌，并把 SKILL 修改提议提交为合并请求（GitLab MR 或 GitHub PR）。
 *
 * 只从 `dsh-repo/contract` 引入类型；服务在运行时经 `ctx.get('dshRepos')`
 * 取得，版本不符或缺少本插件用到的方法（早于 0.1.0-beta.3 的 dsh-repo）时
 * 不调用。
 *
 * @module dsh-guanxiang/repos/lookup
 */

import type { DshRepoService, DshReposVersion, RepoErrorCode } from 'dsh-repo/contract'

/** Name dsh-repo provides the service under. */
export const DSH_REPOS_SERVICE = 'dshRepos'

/** The `dshRepos` contract version this plugin speaks. */
export const DSH_REPOS_VERSION: DshReposVersion = 1

/** Oldest dsh-repo release providing every method {@link REQUIRED_METHODS} lists. */
export const DSH_REPO_MIN_RELEASE = '0.1.0-beta.3'

/** Methods this plugin calls; `getBranch` also marks a provider that honors `baseSha` and `newBranch` on commits. */
const REQUIRED_METHODS = [
  'getBranch', 'commitFiles', 'createChange',
  'listHosts', 'addHost', 'removeHost', 'setHostToken',
  'mirrorSettings', 'syncMirror', 'readMirrorFile', 'listMirrorTree', 'acquireSnapshot',
] as const satisfies readonly (keyof DshRepoService)[]

/** Result of looking the service up. */
export type ReposLookup =
  | { readonly availability: 'ready'; readonly service: DshRepoService }
  | { readonly availability: 'missing' | 'incompatible' }

/**
 * Classify the value `ctx.get('dshRepos')` returned. The provider is another
 * package that may be older or newer than this one, so its version and
 * methods are checked at run time.
 * @param value - the looked-up service, or undefined.
 * @returns the usable service, or why there is none.
 */
export function lookupRepos(value: unknown): ReposLookup {
  if (value === undefined || value === null) return { availability: 'missing' }
  const service = value as Partial<Record<keyof DshRepoService, unknown>>
  if (service.version !== DSH_REPOS_VERSION || REQUIRED_METHODS.some(method => typeof service[method] !== 'function')) {
    return { availability: 'incompatible' }
  }
  return { availability: 'ready', service: value as DshRepoService }
}

/**
 * The failure class of a `dshRepos` rejection.
 * @param error - the rejection.
 * @returns its `code` when it is a `RepoError`.
 */
export function repoErrorCode(error: unknown): RepoErrorCode | undefined {
  if (!(error instanceof Error) || error.name !== 'RepoError') return undefined
  const code = (error as Error & { code?: unknown }).code
  return typeof code === 'string' ? code as RepoErrorCode : undefined
}

/**
 * Why the service cannot be used, as one line for the panel and tool errors.
 * @param availability - lookup outcome other than `ready`.
 * @returns the reason and the fix.
 */
export function unavailableMessage(availability: 'missing' | 'incompatible'): string {
  return availability === 'missing'
    ? `观象需要 dsh-repo 插件提供的 ${DSH_REPOS_SERVICE} 服务来拉取仓库和提交 SKILL 修改；请安装 dsh-repo`
    : `dsh-repo 的 ${DSH_REPOS_SERVICE} 服务与观象不兼容（需要服务版本 ${DSH_REPOS_VERSION}，即 dsh-repo ${DSH_REPO_MIN_RELEASE} 及以上）；请升级 dsh-repo`
}

/**
 * The usable service, or a thrown error saying why there is none.
 * @param value - the looked-up service, or undefined.
 * @returns the service.
 * @throws Error with {@link unavailableMessage} when it is missing or incompatible.
 */
export function requireRepos(value: unknown): DshRepoService {
  const lookup = lookupRepos(value)
  if (lookup.availability !== 'ready') throw new Error(unavailableMessage(lookup.availability))
  return lookup.service
}

/**
 * Readable message of a `dshRepos` rejection or any other thrown value.
 * @param error - the rejection.
 * @returns its message.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
