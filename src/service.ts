/**
 * 观象运行时：持有生效设置（cordis.yml + 面板覆盖）、应用注册表、入口
 * SKILL 与派发工具的注册，并为设置面板提供状态与写入口。
 *
 * @module dsh-guanxiang/service
 */

import { applyOverlay, defaultsOf, describeIssue, editableSettingsSchema } from './config.ts'
import type { GuanxiangConfig, SettingsOverlay } from './config.ts'
import { abortable } from './abort.ts'
import { Dispatcher, isDelegatedAgent } from './dispatch/tool.ts'
import type { HostContext, ToolActivationContext, WorkingDirectoryService } from './host.ts'
import { runGit } from './repos/git.ts'
import type { GitRunner } from './repos/git.ts'
import { RepoRegistry } from './repos/registry.ts'
import type { EditableSettings, StateWire } from './settings/contract.ts'
import { diffOverlay, overriddenKeys } from './settings/overlay.ts'
import type { OverlayStore } from './settings/overlay.ts'
import { createEntrySkillProvider } from './skill/entry.ts'

/** A settings write the panel reports as a field error. */
export class SettingsError extends Error {}

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
    this.registry = new RepoRegistry({
      git: options.git ?? runGit,
      gitTimeoutMs: config.gitTimeoutMs,
      onChange: () => { this.onRegistryChange() },
    })
    this.dispatcher = new Dispatcher({
      registry: this.registry,
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
    })
  }

  /** Register the entry skill provider; called once from `apply()`. */
  registerSkill(): void {
    this.ctx.effect(() => this.ctx.skills.registerProvider(this.skill.factory), 'guanxiang: entry skill')
  }

  /**
   * Register the dispatch tool; called once from `apply()`. The definition
   * stays fixed because a step drops a tool whose registration changed after
   * the step resolved its tools.
   */
  registerTool(): void {
    this.ctx.effect(
      () => this.ctx.tools.register(this.dispatcher.definition(), { when: context => this.offersTool(context) }),
      'guanxiang: dispatch tool',
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
  state(): StateWire {
    return {
      settings: this.current,
      defaults: this.defaults,
      overridden: overriddenKeys(this.overlay),
      ...this.overlayError === undefined ? {} : { overlayError: this.overlayError },
      repos: this.registry.status(),
    }
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
    return this.state()
  }

  /**
   * Remove every panel override.
   * @returns the new panel state.
   */
  async reset(): Promise<StateWire> {
    await this.store.write({})
    this.apply({})
    return this.state()
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

  private apply(overlay: SettingsOverlay): void {
    this.overlay = overlay
    this.overlayError = undefined
    this.current = applyOverlay(this.defaults, overlay)
    const changed = this.registry.configure(this.current.reposDir, this.current.repos)
    void this.registry.syncUrls(changed)
  }

  private onRegistryChange(): void {
    if (!this.active) return
    this.skill.invalidate()
  }
}
