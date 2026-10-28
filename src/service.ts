/**
 * 观象运行时：持有生效设置（cordis.yml + 面板覆盖）、应用注册表、入口
 * SKILL、派发工具与 SKILL 提议工具的注册，并为设置面板提供状态与写入口。
 *
 * @module dsh-guanxiang/service
 */

import { z } from 'zod'
import { applyOverlay, defaultsOf, describeIssue, editableSettingsSchema, expandHome } from './config.ts'
import type { GuanxiangConfig, SettingsOverlay } from './config.ts'
import { abortable } from './abort.ts'
import { Dispatcher, isDelegatedAgent, isInside } from './dispatch/tool.ts'
import type { HostApproval, HostContext, HostCredentials, ToolActivationContext, WorkingDirectoryService } from './host.ts'
import { credentialEnvironment, credentialFor, isAcceptedToken, MAX_TOKEN_LENGTH } from './repos/credentials.ts'
import { runGit } from './repos/git.ts'
import type { GitRunner } from './repos/git.ts'
import { RepoRegistry } from './repos/registry.ts'
import type { CredentialsWire, EditableSettings, StateWire, TokenStatusWire } from './settings/contract.ts'
import { diffOverlay, overriddenKeys } from './settings/overlay.ts'
import type { OverlayStore } from './settings/overlay.ts'
import { createEntrySkillProvider } from './skill/entry.ts'
import { SkillUpdater } from './skill-update/tool.ts'

/** A settings write the panel reports as a field error. */
export class SettingsError extends Error {}

const tokenClearSchema = z.object({ tokenEnv: z.string() }).strict()
const tokenSetSchema = tokenClearSchema.extend({
  value: z.string().trim().refine(isAcceptedToken, `令牌不能为空、超过 ${MAX_TOKEN_LENGTH} 个字符或包含换行等控制字符`),
}).strict()

/** Optional seams for tests. */
export interface ServiceOptions {
  readonly git?: GitRunner
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
    this.current = this.defaults
    const git = options.git ?? runGit
    this.registry = new RepoRegistry({
      git,
      gitTimeoutMs: config.gitTimeoutMs,
      auth: url => this.gitAuth(url),
      onChange: () => { this.onRegistryChange() },
    })
    this.updater = new SkillUpdater({
      registry: this.registry,
      settings: () => this.current,
      git,
      gitTimeoutMs: config.gitTimeoutMs,
      ...config.skillUpdateAuthor === undefined ? {} : { author: config.skillUpdateAuthor },
      approval: () => ctx.get?.('approval') as HostApproval | undefined,
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
      inRepositories: cwd => isInside(cwd, expandHome(this.current.reposDir)),
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
    this.registry.configure(this.current.reposDir, this.current.repos)
    await this.registry.syncAll()
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
      credentials: await this.credentialsState(),
    }
  }

  private credentialStore(): HostCredentials | undefined {
    return this.ctx.get?.('credentials') as HostCredentials | undefined
  }

  private async credentialsState(): Promise<CredentialsWire> {
    const store = this.credentialStore()
    if (store === undefined) return { available: false, tokens: [] }
    const names = [...new Set(this.current.gitCredentials.map(credential => credential.tokenEnv))]
    const tokens = await Promise.all(names.map(async (tokenEnv): Promise<TokenStatusWire> => {
      try {
        const info = await store.describe(tokenEnv)
        return { tokenEnv, configured: info.configured, ...info.source === undefined ? {} : { source: info.source }, writable: info.writable }
      } catch (error) {
        return { tokenEnv, configured: false, writable: false, error: error instanceof Error ? error.message : String(error) }
      }
    }))
    return { available: true, tokens }
  }

  /**
   * Environment carrying the access token for one repository address; empty
   * when no access-token configuration matches it.
   * @param url - repository address.
   * @returns variables for its network git commands.
   * @throws when a configuration matches but its token cannot be read.
   */
  private async gitAuth(url: string): Promise<Record<string, string>> {
    const spec = credentialFor(url, this.current.gitCredentials)
    if (spec === undefined) return {}
    const store = this.credentialStore()
    if (store === undefined) throw new Error(`地址匹配访问令牌 ${spec.url}，但当前 DSH 组合没有凭据服务，无法读取 ${spec.tokenEnv}`)
    const token = await store.resolve(spec.tokenEnv)
    if (token === undefined) throw new Error(`地址匹配访问令牌 ${spec.url}，但 ${spec.tokenEnv} 未设置：请在观象面板「访问令牌」中保存令牌，或设置同名环境变量`)
    if (!isAcceptedToken(token.value)) throw new Error(`${spec.tokenEnv} 的值不能用作令牌：不能超过 ${MAX_TOKEN_LENGTH} 个字符或包含换行等控制字符`)
    return credentialEnvironment(spec, token.value)
  }

  /**
   * Store the token of one access-token configuration in DSH's credential
   * store, then re-sync the repositories that use it.
   * @param raw - request body `{ tokenEnv, value }`.
   * @returns the new panel state.
   * @throws SettingsError when the body is invalid, the name is not referenced by the saved settings, or no credential store is loaded.
   */
  async setToken(raw: unknown): Promise<StateWire> {
    const parsed = tokenSetSchema.safeParse(raw)
    if (!parsed.success) throw new SettingsError(describeIssue(parsed.error))
    return await this.writeToken(parsed.data.tokenEnv, parsed.data.value)
  }

  /**
   * Remove the stored token of one access-token configuration; an environment
   * variable of the same name applies again afterwards.
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
    if (!this.current.gitCredentials.some(credential => credential.tokenEnv === tokenEnv)) throw new SettingsError(`${tokenEnv} 不是已保存的访问令牌配置引用的名称`)
    const store = this.credentialStore()
    if (store === undefined) throw new SettingsError('当前 DSH 组合没有凭据服务（@deepseek-ai/dsh-credentials-local），无法保存令牌')
    if (value === undefined) await store.unset(tokenEnv)
    else await store.set(tokenEnv, value)
    void this.registry.resyncUrls(this.current.repos.map(repo => repo.url).filter(url => credentialFor(url, this.current.gitCredentials)?.tokenEnv === tokenEnv))
    return await this.state()
  }

  /**
   * Validate and persist a complete settings payload from the panel, then
   * sync repositories whose address, branch, or directory changed.
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

  /**
   * Make an overlay effective and sync the repositories whose address, branch,
   * directory, or matching access-token configuration changed.
   */
  private apply(overlay: SettingsOverlay): void {
    const previous = this.current.gitCredentials
    this.overlay = overlay
    this.overlayError = undefined
    this.current = applyOverlay(this.defaults, overlay)
    const changed = this.registry.configure(this.current.reposDir, this.current.repos)
    const next = this.current.gitCredentials
    const reauthorized = this.current.repos.map(repo => repo.url)
      .filter(url => JSON.stringify(credentialFor(url, previous)) !== JSON.stringify(credentialFor(url, next)))
    void this.registry.syncUrls(changed)
    void this.registry.resyncUrls(reauthorized.filter(url => !changed.includes(url)))
  }

  private onRegistryChange(): void {
    if (!this.active) return
    this.skill.invalidate()
  }
}
