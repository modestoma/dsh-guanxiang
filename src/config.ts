/**
 * 插件配置：cordis.yml 中的 `config`（经 Standard Schema 在加载时校验）与
 * Web 面板覆盖共用同一套字段校验。
 *
 * @module dsh-guanxiang/config
 */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import type { EditableSettings } from './settings/contract.ts'

/** Largest delay Node's `setTimeout` honors (2^31 − 1 ms). */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

const SCP_LIKE = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/
const URL_SCHEMES = new Set(['https:', 'http:', 'ssh:', 'git:', 'file:'])
const HOST_NAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

/**
 * Whether a string is a git remote this plugin hands to `git clone`: an
 * `https`/`http`/`ssh`/`git`/`file` URL, an scp-like `user@host:path`, or an
 * absolute local path. Other transports (notably `ext::`) are refused.
 * @param value - candidate remote address.
 * @returns whether it is accepted.
 */
export function isAcceptedGitUrl(value: string): boolean {
  if (value.startsWith('-') || /\s/.test(value)) return false
  if (SCP_LIKE.test(value)) return true
  if (isAbsolute(value)) return true
  try {
    return URL_SCHEMES.has(new URL(value).protocol)
  } catch {
    // Not a URL and not scp-like: refused.
    return false
  }
}

/**
 * Whether a branch name is safe to pass as a git ref argument.
 * @param value - candidate branch name.
 * @returns whether it is accepted.
 */
export function isAcceptedBranch(value: string): boolean {
  return value !== ''
    && !value.startsWith('-')
    && !value.includes('..')
    && !/[\s~^:?*[\\]/.test(value)
    && !value.endsWith('/')
    && !value.endsWith('.lock')
}

const repoSchema = z.object({
  url: z.string().trim().min(1, 'git 地址不能为空').refine(isAcceptedGitUrl, '不支持的 git 地址（支持 https/ssh/git/file URL、user@host:path 或绝对路径）'),
  branch: z.string().trim().optional().transform(value => value === '' ? undefined : value)
    .refine(value => value === undefined || isAcceptedBranch(value), '分支名不合法'),
}).strict()

const hostSchema = z.string().trim().toLowerCase()
  .transform(value => value.replace(/^\*\./, ''))
  .refine(value => HOST_NAME.test(value), '域名不合法：只填主机名，例如 oss.example.com')

const durationMs = (min: number) => z.number().int().min(min).max(MAX_TIMER_DELAY_MS)

const downloadSchema = z.object({
  allowedHosts: z.array(hostSchema).default([]),
  maxBytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(512 * 1024 * 1024),
  timeoutMs: durationMs(1000).default(10 * 60 * 1000),
}).strict()

/** Field validators shared by the cordis config and the panel overlay. */
export const editableFields = {
  reposDir: z.string().trim().min(1, '拉取目录不能为空'),
  repos: z.array(repoSchema).superRefine((repos, issues) => {
    const seen = new Set<string>()
    for (const [index, repo] of repos.entries()) {
      if (seen.has(repo.url)) issues.addIssue({ code: 'custom', path: [index, 'url'], message: `重复的 git 地址：${repo.url}` })
      seen.add(repo.url)
    }
  }),
  fetchIntervalMs: durationMs(0),
  maxAppsPerRequest: z.number().int().min(1).max(32),
  dispatchTimeoutMs: durationMs(1000),
  download: downloadSchema,
}

const configSchema = z.object({
  reposDir: editableFields.reposDir.optional(),
  repos: editableFields.repos.default([]),
  fetchIntervalMs: editableFields.fetchIntervalMs.default(0),
  maxAppsPerRequest: editableFields.maxAppsPerRequest.default(4),
  dispatchTimeoutMs: editableFields.dispatchTimeoutMs.default(30 * 60 * 1000),
  download: downloadSchema.prefault({}),
  /** Registered `ctx.subagents` provider the children start on. */
  subagentProvider: z.string().trim().min(1).default('spawn'),
  /** Timeout of one git command (clone, fetch, worktree), in milliseconds. */
  gitTimeoutMs: durationMs(1000).default(10 * 60 * 1000),
  /**
   * How long loading `/guanxiang` waits for the repository refresh before it
   * renders the catalog it already has, in milliseconds; the refresh keeps
   * running. 0 never waits.
   */
  refreshWaitMs: durationMs(0).default(15 * 1000),
  /**
   * Whether top-level agents may load the entry skill without `/guanxiang`
   * when a task matches the usable applications its description lists.
   */
  autoInvoke: z.boolean().default(true),
}).strict()

/** Validated plugin configuration. */
export type GuanxiangConfig = z.output<typeof configSchema>

/** Standard Schema the Cordis loader validates `config` with before `apply()`. */
export const pluginConfigSchema = configSchema.prefault({})

/** Panel overlay: any subset of the editable settings. */
export const overlaySchema = z.object({
  reposDir: editableFields.reposDir.optional(),
  repos: editableFields.repos.optional(),
  fetchIntervalMs: editableFields.fetchIntervalMs.optional(),
  maxAppsPerRequest: editableFields.maxAppsPerRequest.optional(),
  dispatchTimeoutMs: editableFields.dispatchTimeoutMs.optional(),
  download: downloadSchema.optional(),
}).strict()

/** Validated panel overlay. */
export type SettingsOverlay = z.output<typeof overlaySchema>

/** A complete editable settings payload, as the panel saves it. */
export const editableSettingsSchema = z.object(editableFields).strict()

/**
 * Format the first validation issue as one panel/log line.
 * @param error - zod failure.
 * @returns `path: message`.
 */
export function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0]
  if (issue === undefined) return '配置不合法'
  const where = issue.path.length === 0 ? '' : `${issue.path.join('.')}: `
  return `${where}${issue.message}`
}

/**
 * Validate the raw loader config. The loader has already validated it when the
 * plugin runs under DSH; direct callers (tests, embedding hosts) pass raw input.
 * @param raw - the `config` object, possibly undefined.
 * @returns validated configuration.
 * @throws when the configuration is invalid.
 */
export function resolveConfig(raw: unknown): GuanxiangConfig {
  const parsed = pluginConfigSchema.safeParse(raw ?? {})
  if (!parsed.success) throw new Error(`guanxiang: 配置不合法：${describeIssue(parsed.error)}`)
  return parsed.data
}

/**
 * `$DSH_HOME`, defaulting to `~/.dsh`.
 * @param env - process environment.
 * @returns the DSH home directory.
 */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DSH_HOME?.trim()
  return configured !== undefined && configured !== '' ? configured : join(homedir(), '.dsh')
}

/**
 * Expand `~` and make a configured directory absolute.
 * @param path - configured directory.
 * @returns absolute directory.
 */
export function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return resolve(path)
}

/**
 * The editable settings a configuration implies, with `reposDir` defaulted to
 * `$DSH_HOME/guanxiang/repos`.
 * @param config - validated plugin configuration.
 * @param env - process environment.
 * @returns complete editable settings.
 */
export function defaultsOf(config: GuanxiangConfig, env: NodeJS.ProcessEnv = process.env): EditableSettings {
  return {
    reposDir: config.reposDir ?? join(resolveDshHome(env), 'guanxiang', 'repos'),
    repos: config.repos.map(repo => repo.branch === undefined ? { url: repo.url } : { url: repo.url, branch: repo.branch }),
    fetchIntervalMs: config.fetchIntervalMs,
    maxAppsPerRequest: config.maxAppsPerRequest,
    dispatchTimeoutMs: config.dispatchTimeoutMs,
    download: { ...config.download, allowedHosts: [...config.download.allowedHosts] },
  }
}

/**
 * Apply a panel overlay over the defaults. Each overridden key replaces the
 * default wholesale.
 * @param defaults - settings from the configuration.
 * @param overlay - validated overlay.
 * @returns effective settings.
 */
export function applyOverlay(defaults: EditableSettings, overlay: SettingsOverlay): EditableSettings {
  const repos = overlay.repos?.map(repo => repo.branch === undefined ? { url: repo.url } : { url: repo.url, branch: repo.branch })
  return {
    reposDir: overlay.reposDir ?? defaults.reposDir,
    repos: repos ?? defaults.repos,
    fetchIntervalMs: overlay.fetchIntervalMs ?? defaults.fetchIntervalMs,
    maxAppsPerRequest: overlay.maxAppsPerRequest ?? defaults.maxAppsPerRequest,
    dispatchTimeoutMs: overlay.dispatchTimeoutMs ?? defaults.dispatchTimeoutMs,
    download: overlay.download ?? defaults.download,
  }
}
