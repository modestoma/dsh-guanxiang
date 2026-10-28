/**
 * 观象 GuanXiang —— DeepSeek Harness 日志分析插件。观其象，知其因。
 *
 * 提供入口 SKILL `/guanxiang`（识别日志属于哪个应用；用户显式调用，或在
 * 任务匹配已注册应用时由顶层 Agent 自行加载）和
 * `guanxiang_dispatch` 工具（按应用派发子 Agent，工作目录为该应用的代码
 * 仓库，首条消息用 `/<skill>` 加载仓库里的日志分析 SKILL）。应用仓库在设置
 * 面板中只填 git 地址，由插件拉取；应用描述来自各仓库的
 * `.dsh/guanxiang.yaml`。
 *
 * @module dsh-guanxiang
 */

import { resolveConfig } from './config.ts'
import type { HostContext } from './host.ts'
import { GuanxiangService } from './service.ts'
import type { ServiceOptions } from './service.ts'
import { defaultOverlayPath, OverlayStore } from './settings/overlay.ts'
import { mountSettingsRoutes } from './settings/routes.ts'

export type * from './settings/contract.ts'
export type { GuanxiangConfig, SettingsOverlay } from './config.ts'
export { pluginConfigSchema, resolveConfig } from './config.ts'
export { DISPATCH_TOOL_NAME, Dispatcher } from './dispatch/tool.ts'
export type { DispatchValue, TaskResult } from './dispatch/tool.ts'
export { renderChildPrompt } from './dispatch/prompt.ts'
export { ENTRY_SKILL_NAME, renderEntrySkill } from './skill/entry.ts'
export { RepoRegistry } from './repos/registry.ts'
export { readAppManifest, MANIFEST_PATH } from './repos/manifest.ts'
export { GuanxiangService } from './service.ts'
export { SETTINGS_ROUTE, STATE_ROUTE, SYNC_ROUTE } from './settings/contract.ts'

/** Cordis plugin name. */
export const name = 'guanxiang'

/** Host services the plugin needs before `apply()`. */
export const inject = ['tools', 'skills', 'subagents'] as const

/** Standard Schema the loader validates `config` with before `apply()`. */
export { pluginConfigSchema as Config } from './config.ts'

/** Direct-invocation options (tests and embedding hosts). */
export interface GuanxiangPluginOptions extends ServiceOptions {
  /** Overlay file path; defaults to `$DSH_HOME/guanxiang/settings.json`. */
  readonly overlayPath?: string
}

/**
 * Install the entry skill, the dispatch tool, and the settings routes, then
 * clone or update the configured repositories in the background.
 * @param ctx - plugin context.
 * @param config - loader-validated configuration.
 * @param options - test seams.
 */
export function apply(ctx: HostContext, config?: unknown, options: GuanxiangPluginOptions = {}): void {
  const service = new GuanxiangService(ctx, resolveConfig(config), new OverlayStore(options.overlayPath ?? defaultOverlayPath()), options)
  service.registerSkill()
  service.registerTool()
  mountSettingsRoutes(ctx, service)
  ctx.effect(() => {
    void service.boot().catch((error: unknown) => {
      ctx.logger?.error?.('guanxiang: 启动失败：%s', error instanceof Error ? error.message : String(error))
    })
    return () => { service.shutdown() }
  }, 'guanxiang: repositories')
}
