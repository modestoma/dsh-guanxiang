/**
 * 观象运行时：持有生效设置（cordis.yml + 面板覆盖）、应用注册表、入口
 * SKILL、派发工具与 SKILL 提议工具的注册，并为设置面板提供状态与写入口。
 *
 * @module dsh-guanxiang/service
 */

import type { DshRepoService } from 'dsh-repo/contract'
import { z } from 'zod'
import { applyOverlay, defaultsOf, describeIssue, editableSettingsSchema } from './config.ts'
import type { GuanxiangConfig, SettingsOverlay } from './config.ts'
import { abortable } from './abort.ts'
import type { AnalyzeGate } from './analyze/server.ts'
import { FEISHU_TOPICS_SERVICE, lookupTopics } from './analyze/topics.ts'
import { Dispatcher, isDelegatedAgent, isInside } from './dispatch/tool.ts'
import type { HostApproval, HostContext, HostCredentials, ToolActivationContext, WorkingDirectoryService } from './host.ts'
import { DSH_REPOS_SERVICE, lookupRepos, messageOf, repoErrorCode, unavailableMessage } from './repos/lookup.ts'
import { RepoRegistry } from './repos/registry.ts'
import { ANALYZE_ROUTE } from './settings/contract.ts'
import type { AnalyzeWire, EditableSettings, HostsWire, StateWire, TokenStatusWire } from './settings/contract.ts'
import { diffOverlay, overriddenKeys } from './settings/overlay.ts'
import type { OverlayStore } from './settings/overlay.ts'
import { createEntrySkillProvider } from './skill/entry.ts'
import { SkillUpdater } from './skill-update/tool.ts'

/** A settings write the panel reports as a field error. */
export class SettingsError extends Error {}

/** Longest accepted token; personal access tokens are far shorter. */
const MAX_TOKEN_LENGTH = 4096

const tokenValue = z.string().trim()
  .refine(value => value.length > 0 && value.length <= MAX_TOKEN_LENGTH && !/[\u0000-\u001f\u007f]/.test(value), `令牌不能为空、超过 ${MAX_TOKEN_LENGTH} 个字符或包含换行等控制字符`)
const tokenClearSchema = z.object({ tokenEnv: z.string() }).strict()
const tokenSetSchema = tokenClearSchema.extend({ value: tokenValue }).strict()
const hostUrlSchema = z.object({ url: z.string().trim().min(1, '主机地址不能为空') }).strict()
const hostTokenSchema = hostUrlSchema.extend({ value: tokenValue }).strict()
const hostAddSchema = z.object({
  kind: z.enum(['github', 'gitlab']).optional(),
  url: z.string().trim().min(1, '主机地址不能为空'),
  alias: z.string().trim().max(64, '别名不能超过 64 个字符').optional().transform(value => value === '' ? undefined : value),
  token: tokenValue.optional(),
}).strict()

/** Optional seams for tests. */
export interface ServiceOptions {
  readonly fetch?: typeof fetch
}

/** The plugin's long-lived state. */
export class GuanxiangService {
  readonly registry: RepoRegistry
  private readonly defaults: EditableSettings
  private overlay: SettingsOverlay = {}
  private overlayError: string | undefined
  private current: EditableSettings
  private readonly dispatcher: Dispatcher
  private readonly updater: SkillUpdater
  private readonly skill: ReturnType<typeof createEntrySkillProvider>
  private active = true
  private readonly refreshWaitMs: number
  private readonly analyzeTokenRef: string
  private readonly booted = Promise.withResolvers<void>()

  /**
   * @param ctx - plugin context.
   * @param config - validated plugin configuration.
   * @param store - panel overlay file.
   * @param options - test seams.
   */
  constructor(
    private readonly ctx: HostContext,
    config: GuanxiangConfig,
    private readonly store: OverlayStore,
    options: ServiceOptions = {},
  ) {
    this.defaults = defaultsOf(config)
    this.refreshWaitMs = config.refreshWaitMs
    this.analyzeTokenRef = config.analyzeTokenRef
    this.current = this.defaults
    this.registry = new RepoRegistry({
      repos: () => ctx.get?.(DSH_REPOS_SERVICE),
      onChange: () => { this.onRegistryChange() },
    })
    this.updater = new SkillUpdater({
      registry: this.registry,
      settings: () => this.current,
      ...config.skillUpdateAuthor === undefined ? {} : { author: config.skillUpdateAuthor },
      approval: () => ctx.get?.('approval') as HostApproval | undefined,
      repos: () => ctx.get?.(DSH_REPOS_SERVICE),
    })
    this.dispatcher = new Dispatcher({
      registry: this.registry,
      proposals: this.updater,
      subagents: ctx.subagents,
      settings: () => this.current,
      provider: config.subagentProvider,
      workingDirectory: () => ctx.get?.('workingDirectory') as WorkingDirectoryService | undefined,
      ...options.fetch === undefined ? {} : { fetch: options.fetch },
    })
    this.skill = createEntrySkillProvider({
      prepare: signal => this.prepareCatalog(signal),
      apps: () => this.registry.readyApps().map(ready => ready.app),
      maxAppsPerRequest: () => this.current.maxAppsPerRequest,
      skillUpdates: () => this.current.skillUpdates.enabled,
      autoInvoke: config.autoInvoke,
      inRepositories: (cwd) => {
        const lookup = lookupRepos(ctx.get?.(DSH_REPOS_SERVICE))
        return lookup.availability === 'ready' && isInside(cwd, lookup.service.mirrorSettings().dir)
      },
    })
  }

  /** Register the entry skill provider; called once from `apply()`. */
  registerSkill(): void {
    this.ctx.effect(() => this.ctx.skills.registerProvider(this.skill.factory), 'guanxiang: entry skill')
  }

  /**
   * Register the dispatch and SKILL proposal tools; called once from
   * `apply()`. The definitions stay fixed because a step drops a tool whose
   * registration changed after the step resolved its tools.
   */
  registerTool(): void {
    this.ctx.effect(
      () => this.ctx.tools.register(this.dispatcher.definition(), { when: context => this.offersTool(context) }),
      'guanxiang: dispatch tool',
    )
    this.ctx.effect(
      () => this.ctx.tools.register(this.updater.definition(), { when: async context => this.current.skillUpdates.enabled && await this.offersTool(context) }),
      'guanxiang: skill proposal tool',
    )
  }

  /**
   * Offer the tool to top-level agents once the first sync settled and at
   * least one application is usable.
   * @param context - the preparing step.
   * @returns whether the step may call the tool.
   */
  private async offersTool({ agent, signal }: ToolActivationContext): Promise<boolean> {
    if (isDelegatedAgent(agent)) return false
    await abortable(this.booted.promise, signal)
    return this.active && this.registry.readyApps().length > 0
  }

  /**
   * Wait for the first sync, then sync the repositories older than
   * `fetchIntervalMs`, waiting at most `refreshWaitMs` for them; a refresh
   * still running then finishes in the background.
   * @param signal - entry skill load cancellation.
   * @throws the signal's reason when the load is cancelled.
   */
  private async prepareCatalog(signal: AbortSignal | undefined): Promise<void> {
    await abortable(this.booted.promise, signal)
    if (!this.active) return
    const limit = AbortSignal.timeout(this.refreshWaitMs)
    try {
      await abortable(this.registry.refresh(this.current.fetchIntervalMs), signal === undefined ? limit : AbortSignal.any([signal, limit]))
    } catch (error) {
      if (signal?.aborted === true || !limit.aborted) throw error
      // The wait limit passed: render the catalog synced so far.
    }
  }

  /**
   * Load the panel overlay, configure the registry, and sync every repository.
   * @returns when the first sync round settled.
   */
  async boot(): Promise<void> {
    try {
      await this.bootOnce()
    } finally {
      this.booted.resolve()
    }
  }

  private async bootOnce(): Promise<void> {
    const read = await this.store.read()
    if (read.ok) {
      this.overlay = read.overlay
    } else {
      this.overlayError = read.error
      this.ctx.logger?.warn?.('guanxiang: 忽略面板设置：%s', read.error)
    }
    this.current = applyOverlay(this.defaults, this.overlay)
    this.registry.configure(this.current.repos)
    await this.registry.syncAll()
  }

  /**
   * React to dsh-repo becoming available (or reloading): sync every
   * repository again.
   * @returns when the syncs settled.
   */
  async reposAvailable(): Promise<void> {
    await this.booted.promise
    if (!this.active) return
    await this.registry.resyncAll()
  }

  /** Stop registering tools; in-flight syncs finish without side effects on the host. */
  shutdown(): void {
    this.active = false
    this.booted.resolve()
  }

  /** @returns current effective settings. */
  settings(): EditableSettings {
    return this.current
  }

  /** @returns the panel state. */
  async state(): Promise<StateWire> {
    return {
      settings: this.current,
      defaults: this.defaults,
      overridden: overriddenKeys(this.overlay),
      ...this.overlayError === undefined ? {} : { overlayError: this.overlayError },
      repos: this.registry.status(),
      hosts: await this.hostsState(),
      credentialsAvailable: this.credentialStore() !== undefined,
      analyze: await this.analyzeState(),
    }
  }

  /** @returns the analyze route's switch and bearer token, read per request. */
  analyzeGate(): AnalyzeGate {
    return {
      enabled: () => this.current.analyze.enabled,
      tokenEnv: () => this.analyzeTokenRef,
      token: async () => {
        try {
          return (await this.credentialStore()?.resolve(this.analyzeTokenRef))?.value
        } catch (error) {
          this.ctx.logger?.warn?.('guanxiang: 读取分析接口令牌 %s 失败：%s', this.analyzeTokenRef, error instanceof Error ? error.message : String(error))
          return undefined
        }
      },
    }
  }

  private async analyzeState(): Promise<AnalyzeWire> {
    const store = this.credentialStore()
    return {
      route: ANALYZE_ROUTE,
      tokenEnv: this.analyzeTokenRef,
      ...store === undefined ? {} : { token: await describeToken(store, this.analyzeTokenRef) },
      topics: lookupTopics(this.ctx.get?.(FEISHU_TOPICS_SERVICE)).availability,
    }
  }

  private credentialStore(): HostCredentials | undefined {
    return this.ctx.get?.('credentials') as HostCredentials | undefined
  }

  private async hostsState(): Promise<HostsWire> {
    const lookup = lookupRepos(this.ctx.get?.(DSH_REPOS_SERVICE))
    if (lookup.availability !== 'ready') return { availability: lookup.availability, hosts: [] }
    const mirrorDir = lookup.service.mirrorSettings().dir
    try {
      const hosts = await lookup.service.listHosts()
      return {
        availability: 'ready',
        mirrorDir,
        hosts: hosts.map(host => ({
          kind: host.kind,
          url: host.url,
          ...host.alias === undefined ? {} : { alias: host.alias },
          origin: host.origin,
          token: { tokenEnv: host.tokenRef, ...host.token },
        })),
      }
    } catch (error) {
      return { availability: 'ready', mirrorDir, hosts: [], error: messageOf(error) }
    }
  }

  /**
   * Add a dsh-repo host, optionally with its token, then sync every repository.
   * @param raw - request body `{ kind?, url, alias?, token? }`.
   * @returns the new panel state.
   * @throws SettingsError when the body is invalid, dsh-repo is unavailable, or it refuses the host.
   */
  async addHost(raw: unknown): Promise<StateWire> {
    const parsed = hostAddSchema.safeParse(raw)
    if (!parsed.success) throw new SettingsError(describeIssue(parsed.error))
    const { kind, url, alias, token } = parsed.data
    await this.withRepos(repos => repos.addHost({ url, ...kind === undefined ? {} : { kind }, ...alias === undefined ? {} : { alias }, ...token === undefined ? {} : { token } }))
    return await this.state()
  }

  /**
   * Remove a host added from a panel, and its stored token.
   * @param raw - request body `{ url }`.
   * @returns the new panel state.
   * @throws SettingsError when the body is invalid, dsh-repo is unavailable, or the host is unknown or configured in cordis.yml.
   */
  async removeHost(raw: unknown): Promise<StateWire> {
    const parsed = hostUrlSchema.safeParse(raw)
    if (!parsed.success) throw new SettingsError(describeIssue(parsed.error))
    await this.withRepos(repos => repos.removeHost(parsed.data.url))
    return await this.state()
  }

  /**
   * Store a host's token through dsh-repo, then sync every repository.
   * @param raw - request body `{ url, value }`.
   * @returns the new panel state.
   * @throws SettingsError when the body is invalid, dsh-repo is unavailable, or the host is unknown.
   */
  async setHostToken(raw: unknown): Promise<StateWire> {
    const parsed = hostTokenSchema.safeParse(raw)
    if (!parsed.success) throw new SettingsError(describeIssue(parsed.error))
    await this.withRepos(repos => repos.setHostToken(parsed.data.url, parsed.data.value))
    return await this.state()
  }

  /**
   * Remove a host's stored token; an environment variable of the same name applies again.
   * @param raw - request body `{ url }`.
   * @returns the new panel state.
   * @throws SettingsError on the same conditions as {@link setHostToken}.
   */
  async clearHostToken(raw: unknown): Promise<StateWire> {
    const parsed = hostUrlSchema.safeParse(raw)
    if (!parsed.success) throw new SettingsError(describeIssue(parsed.error))
    await this.withRepos(repos => repos.setHostToken(parsed.data.url, undefined))
    return await this.state()
  }

  /** Run one host change and start a resync, reporting dsh-repo failures as field errors. */
  private async withRepos(change: (repos: DshRepoService) => Promise<unknown>): Promise<void> {
    const lookup = lookupRepos(this.ctx.get?.(DSH_REPOS_SERVICE))
    if (lookup.availability !== 'ready') throw new SettingsError(unavailableMessage(lookup.availability))
    try {
      await change(lookup.service)
    } catch (error) {
      if (repoErrorCode(error) !== undefined) throw new SettingsError(messageOf(error))
      throw error
    }
    void this.registry.resyncAll()
  }

  /**
   * Store the analyze API's bearer token (`analyzeTokenRef`) in DSH's
   * credential store; it applies from the next request.
   * @param raw - request body `{ tokenEnv, value }`.
   * @returns the new panel state.
   * @throws SettingsError when the body is invalid, the name is not `analyzeTokenRef`, or no credential store is loaded.
   */
  async setToken(raw: unknown): Promise<StateWire> {
    const parsed = tokenSetSchema.safeParse(raw)
    if (!parsed.success) throw new SettingsError(describeIssue(parsed.error))
    return await this.writeToken(parsed.data.tokenEnv, parsed.data.value)
  }

  /**
   * Remove the stored analyze token; an environment variable of the same name
   * applies again afterwards.
   * @param raw - request body `{ tokenEnv }`.
   * @returns the new panel state.
   * @throws SettingsError on the same conditions as {@link setToken}.
   */
  async clearToken(raw: unknown): Promise<StateWire> {
    const parsed = tokenClearSchema.safeParse(raw)
    if (!parsed.success) throw new SettingsError(describeIssue(parsed.error))
    return await this.writeToken(parsed.data.tokenEnv, undefined)
  }

  private async writeToken(tokenEnv: string, value: string | undefined): Promise<StateWire> {
    if (tokenEnv !== this.analyzeTokenRef) throw new SettingsError(`${tokenEnv} 不是分析接口令牌的名称`)
    const store = this.credentialStore()
    if (store === undefined) throw new SettingsError('当前 DSH 组合没有凭据服务（@deepseek-ai/dsh-credentials-local），无法保存令牌')
    if (value === undefined) await store.unset(tokenEnv)
    else await store.set(tokenEnv, value)
    return await this.state()
  }

  /**
   * Validate and persist a complete settings payload from the panel, then
   * sync repositories whose address or branch changed.
   * @param raw - request body.
   * @returns the new panel state.
   * @throws SettingsError when the payload is invalid.
   */
  async save(raw: unknown): Promise<StateWire> {
    const parsed = editableSettingsSchema.safeParse(raw)
    if (!parsed.success) throw new SettingsError(describeIssue(parsed.error))
    const overlay = diffOverlay(this.defaults, applyOverlay(this.defaults, parsed.data))
    await this.store.write(overlay)
    this.apply(overlay)
    return await this.state()
  }

  /**
   * Remove every panel override.
   * @returns the new panel state.
   */
  async reset(): Promise<StateWire> {
    await this.store.write({})
    this.apply({})
    return await this.state()
  }

  /**
   * Re-sync one configured repository, or all of them.
   * @param url - address to sync; omitted syncs every repository.
   * @throws SettingsError when the address is not configured.
   */
  sync(url?: string): void {
    if (url !== undefined && !this.registry.has(url)) throw new SettingsError(`未配置的仓库：${url}`)
    void (url === undefined ? this.registry.syncAll() : this.registry.syncUrls([url]))
  }

  /** Make an overlay effective and sync the repositories whose address or branch changed. */
  private apply(overlay: SettingsOverlay): void {
    this.overlay = overlay
    this.overlayError = undefined
    this.current = applyOverlay(this.defaults, overlay)
    void this.registry.syncUrls(this.registry.configure(this.current.repos))
  }

  private onRegistryChange(): void {
    if (!this.active) return
    this.skill.invalidate()
  }
}

async function describeToken(store: HostCredentials, tokenEnv: string): Promise<TokenStatusWire> {
  try {
    const info = await store.describe(tokenEnv)
    return { tokenEnv, configured: info.configured, ...info.source === undefined ? {} : { source: info.source }, writable: info.writable }
  } catch (error) {
    return { tokenEnv, configured: false, writable: false, error: error instanceof Error ? error.message : String(error) }
  }
}
