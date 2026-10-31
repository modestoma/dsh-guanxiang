/**
 * dsh-repo `dshRepos` 服务的查找：SKILL 修改提议经它在代码托管平台上建分支、
 * 提交并创建合并请求（GitLab MR 或 GitHub PR）。
 *
 * 只从 `dsh-repo/contract` 引入类型；服务在运行时经 `ctx.get('dshRepos')`
 * 取得，版本不符或缺少 `getBranch`（早于 0.1.0-beta.2 的 dsh-repo，提交时会忽略
 * `baseSha` 与 `newBranch`）时不调用。
 *
 * @module dsh-guanxiang/skill-update/repos
 */

import type { DshRepoService, DshReposVersion, RepoErrorCode } from 'dsh-repo/contract'

/** Name dsh-repo provides the service under. */
export const DSH_REPOS_SERVICE = 'dshRepos'

/** The `dshRepos` contract version this plugin speaks. */
export const DSH_REPOS_VERSION: DshReposVersion = 1

/** Result of looking the service up. */
export type ReposLookup =
  | { readonly availability: 'ready'; readonly service: DshRepoService }
  | { readonly availability: 'missing' | 'incompatible' }

/**
 * Classify the value `ctx.get('dshRepos')` returned. The provider is another
 * package that may be older or newer than this one, so its version is checked
 * at run time; `getBranch` marks a provider that also honors `baseSha` and
 * `newBranch` on commits.
 * @param value - the looked-up service, or undefined.
 * @returns the usable service, or why there is none.
 */
export function lookupRepos(value: unknown): ReposLookup {
  if (value === undefined || value === null) return { availability: 'missing' }
  const service = value as Partial<Record<keyof DshRepoService, unknown>>
  if (service.version !== DSH_REPOS_VERSION || typeof service.getBranch !== 'function' || typeof service.commitFiles !== 'function' || typeof service.createChange !== 'function') {
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
