/**
 * HTTPS 访问令牌：按地址前缀为仓库挑选令牌配置，并生成只对一次 git 进程生效的
 * 凭据助手配置。令牌经子进程环境变量交给 git，不出现在命令行参数、仓库的
 * `.git/config` 或 git 输出里；只有服务器要求认证时 git 才向助手取令牌，
 * 本机为同一主机配置的其他凭据助手在这次调用中不参与。
 *
 * @module dsh-guanxiang/repos/credentials
 */

import type { GitCredentialSpec } from '../settings/contract.ts'

/** Environment variables the helper reads; set only on git child processes. */
const USERNAME_VARIABLE = 'GUANXIANG_GIT_USERNAME'
const TOKEN_VARIABLE = 'GUANXIANG_GIT_TOKEN'

/** Answers git's `get` request from the two variables and ignores `store` and `erase`. */
const HELPER = `!f() { test "$1" = get || exit 0; printf 'username=%s\\npassword=%s\\n' "$${USERNAME_VARIABLE}" "$${TOKEN_VARIABLE}"; }; f`

/** Credential reference grammar of `@deepseek-ai/dsh-credentials` (a POSIX shell identifier). */
export const TOKEN_ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Longest accepted token; personal access tokens are far shorter. */
export const MAX_TOKEN_LENGTH = 4096

/**
 * Normalize an access-token address prefix to `scheme://host[:port][/path]`
 * with a lowercase host and no trailing slash.
 * @param value - candidate prefix.
 * @returns the normalized prefix, or undefined when it is not an `https`/`http` URL without credentials, query, or fragment.
 */
export function normalizeCredentialUrl(value: string): string | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    // Not a URL: refused.
    return undefined
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
  if (url.host === '' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return undefined
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`
}

/**
 * Whether a token value can be handed to git: non-empty, bounded, and free of
 * control characters, which would break the credential helper protocol.
 * @param value - candidate token.
 * @returns whether it is accepted.
 */
export function isAcceptedToken(value: string): boolean {
  return value.length > 0 && value.length <= MAX_TOKEN_LENGTH && !/[\u0000-\u001f\u007f]/.test(value)
}

/**
 * The access-token configuration for a repository address: the entry whose
 * prefix has the same scheme and host and the longest path that contains the
 * repository path. scp-like addresses, SSH URLs, and local paths never match.
 * @param url - repository address.
 * @param specs - configured access tokens with normalized prefixes.
 * @returns the matching entry, if any.
 */
export function credentialFor(url: string, specs: readonly GitCredentialSpec[]): GitCredentialSpec | undefined {
  let repo: URL
  try {
    repo = new URL(url)
  } catch {
    // scp-like addresses and local paths use other credentials.
    return undefined
  }
  let best: { spec: GitCredentialSpec; length: number } | undefined
  for (const spec of specs) {
    const prefix = new URL(spec.url)
    if (prefix.protocol !== repo.protocol || prefix.host !== repo.host) continue
    const path = prefix.pathname.replace(/\/+$/, '')
    if (path !== '' && repo.pathname !== path && !repo.pathname.startsWith(`${path}/`)) continue
    if (best === undefined || path.length > best.length) best = { spec, length: path.length }
  }
  return best?.spec
}

/**
 * Environment that makes one git process answer the credential request for
 * the token's host with the given token. Existing `GIT_CONFIG_COUNT` entries
 * are kept; the helper list for that host is reset first so a stale password
 * from another helper cannot shadow the token.
 * @param spec - matching access-token configuration.
 * @param token - token value.
 * @param env - environment of the git process before this call.
 * @returns variables to add to the git process environment.
 */
export function credentialEnvironment(spec: GitCredentialSpec, token: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const prefix = new URL(spec.url)
  const key = `credential.${prefix.protocol}//${prefix.host}.helper`
  const parsed = Number(env.GIT_CONFIG_COUNT ?? '0')
  const base = Number.isInteger(parsed) && parsed > 0 ? parsed : 0
  return {
    GIT_CONFIG_COUNT: String(base + 2),
    [`GIT_CONFIG_KEY_${base}`]: key,
    [`GIT_CONFIG_VALUE_${base}`]: '',
    [`GIT_CONFIG_KEY_${base + 1}`]: key,
    [`GIT_CONFIG_VALUE_${base + 1}`]: HELPER,
    [USERNAME_VARIABLE]: spec.username,
    [TOKEN_VARIABLE]: token,
  }
}
