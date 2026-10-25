/**
 * `/guanxiang` 入口 SKILL：只供用户显式调用（模型不会自行加载），正文中的
 * 应用目录在每次加载时由已就绪仓库的应用描述生成。
 *
 * @module dsh-guanxiang/skill/entry
 */

import { abortable } from '../abort.ts'
import type { SkillCandidate, SkillDefinition, SkillProvider, SkillProviderControl } from '../host.ts'
import type { AppManifest } from '../settings/contract.ts'
import { DISPATCH_TOOL_NAME } from '../dispatch/tool.ts'

/** Entry skill name, addressed as `/guanxiang`. */
export const ENTRY_SKILL_NAME = 'guanxiang'

/** Skill provider name in `ctx.skills`. */
export const SKILL_PROVIDER_NAME = 'dsh-guanxiang'

/** DSH's precedence rank for packaged skill providers (`BUNDLED_SKILL_RANK`). */
export const BUNDLED_SKILL_RANK = 600

const DESCRIPTION = '观象日志分析入口：识别日志属于哪个应用，并派发给在该应用代码仓库中工作的子 Agent 分析根因。'

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

/**
 * Render the application catalog as a Markdown table.
 * @param apps - usable applications.
 * @returns the table, or a notice when none is usable.
 */
export function renderCatalog(apps: readonly AppManifest[]): string {
  if (apps.length === 0) {
    return '当前没有可用的应用。请告诉用户：在 DSH Web 左侧栏「观象」面板的「应用仓库」中添加应用的 git 地址，并确认仓库已拉取成功、包含 `.dsh/guanxiang.yaml` 与对应的日志分析 SKILL。然后结束本次回复，不要自行分析日志。'
  }
  const rows = apps.map(app => `| \`${app.id}\` | ${cell(app.name)} | ${cell(app.description)} | ${cell(app.aliases.join('、') || '—')} | ${cell(app.logHints.map(hint => `\`${hint}\``).join(' ') || '—')} |`)
  return ['| 应用 id | 名称 | 描述 | 别名 | 日志特征 |', '| --- | --- | --- | --- | --- |', ...rows].join('\n')
}

/**
 * The entry skill body.
 * @param apps - usable applications at load time.
 * @param maxAppsPerRequest - dispatch task ceiling.
 * @returns Markdown instructions.
 */
export function renderEntrySkill(apps: readonly AppManifest[], maxAppsPerRequest: number): string {
  return `# 观象：日志分析入口

观其象，知其因。你负责「意图识别 + 派发 + 汇总」：判断每份日志属于哪个应用，用 \`${DISPATCH_TOOL_NAME}\` 交给在该应用代码仓库里工作的子 Agent 分析，再把各应用的结论汇总给用户。你自己不做逐行日志分析。

## 应用目录

${renderCatalog(apps)}

## 步骤

1. **读需求。** 从 \`/guanxiang\` 之后的文字、消息附带的附件、消息里的下载 URL 中找出：要分析的现象、时间范围、关键标识（用户 id、订单号、请求 id 等）、日志位置。
2. **确定应用。** 拆分单位是「日志来源 → 应用」。
   - 用户或调用方已经写明应用 id 时直接使用；该 id 不在上表中时，告诉用户这个应用未注册（列出可用的应用 id），然后结束，不要改用别的应用。
   - 否则按名称、别名、描述和日志特征匹配。只有附件文件名或内容能区分时，可以只看日志开头几十行来判断，不要通读或解压整个日志。
   - 无法确定或同时匹配多个应用时，用 \`ask_user_question\`（不可用时直接在回复中提问并结束）让用户选择，不要猜。
   - 一个文件混有多个应用的输出时，把同一路径分别交给各应用，并在 \`filter\` 里写明区分方式（tag、进程名等）。
3. **派发。** 一次调用 \`${DISPATCH_TOOL_NAME}\`，把所有任务放进 \`tasks\`（最多 ${maxAppsPerRequest} 个）：
   - \`app\`：上表中的应用 id。
   - \`question\`：给子 Agent 的完整问题。子 Agent 看不到本对话，要写清现象、时间、关键标识和用户的原话要点。
   - \`logs\`：每项是 \`{ "path": 绝对路径 }\`（附件、本机文件）或 \`{ "url": 下载地址 }\`（对象存储链接，由工具下载），可加 \`filter\`。
   - 没有任何日志时，先向用户要日志，不要派发。
   工具会等待全部子 Agent 结束后一次返回结果。工具报错（应用不可用、路径不存在、域名不在白名单等）时，把原因告诉用户，不要绕过。
4. **汇总回复。** 按下面的格式写最终回复：

\`\`\`
## 结论
一两句话说明根因或当前判断。

## <应用名>
- 结论：……
- 关键证据：日志原文片段（带时间戳）与对应代码位置
- 建议：……

## 推演
（涉及两个及以上应用时）按时间线关联各应用的事件，说明跨应用的因果关系与仍待验证的假设。
\`\`\`

   每个派发的应用都有一节。子 Agent 失败、超时或结论不充分时，在该节如实说明，不要编造结论。日志版本与仓库代码可能不一致，子 Agent 提示了版本差异时保留这条提示。
`
}

/** Inputs the provider reads at each load. */
export interface EntrySkillSource {
  /** Settles once the first repository sync after startup finished, so an early `/guanxiang` sees the cloned applications. */
  ready(): Promise<void>
  /** Usable applications. */
  apps(): readonly AppManifest[]
  /** Current dispatch task ceiling. */
  maxAppsPerRequest(): number
}

/**
 * Build the entry skill provider.
 * @param source - live registry view.
 * @returns a provider factory for `ctx.skills.registerProvider`, plus the
 *   invalidation hook to call after the catalog changes.
 */
export function createEntrySkillProvider(source: EntrySkillSource): {
  factory: (control: SkillProviderControl) => SkillProvider
  invalidate: () => void
} {
  let control: SkillProviderControl | undefined
  const summary = {
    name: ENTRY_SKILL_NAME,
    description: DESCRIPTION,
    whenToUse: '仅在用户输入 /guanxiang 时使用。',
    invocation: { modelInvocable: false, userInvocable: true },
    source: 'bundled',
    provider: SKILL_PROVIDER_NAME,
  } as const
  const candidate: SkillCandidate = { ...summary, rank: BUNDLED_SKILL_RANK, locator: ENTRY_SKILL_NAME }
  return {
    factory: (registration) => {
      control = registration
      return {
        name: SKILL_PROVIDER_NAME,
        list: () => Promise.resolve([candidate]),
        get: async (requested, options): Promise<SkillDefinition | undefined> => {
          if (requested.name !== ENTRY_SKILL_NAME) return undefined
          await abortable(source.ready(), options.signal)
          return { ...summary, content: renderEntrySkill(source.apps(), source.maxAppsPerRequest()) }
        },
      }
    },
    invalidate: () => {
      if (control !== undefined && !control.signal.aborted) control.invalidate()
    },
  }
}
