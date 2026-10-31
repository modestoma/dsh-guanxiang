/**
 * `logalyze_propose_skill`：把某个派发任务的 SKILL 修改提议提交为合并请求。
 *
 * - 只接受本进程中由同一会话派发过的任务运行目录；应用、仓库和分析时的提交
 *   取自派发记录，不取自运行目录里可被 Agent 改写的内容。
 * - 只改应用 SKILL 目录 `.dsh/skills/<skill>/` 下的文件，提交以分析时的提交为
 *   父提交，提交到新分支 `logalyze/skill-<应用 id>-<改动摘要前缀>`，从不提交到
 *   已有分支或默认分支。
 * - 提交和创建合并请求经 dsh-repo 的 `dshRepos` 服务完成，支持 GitLab 与
 *   GitHub；令牌由 dsh-repo 按主机配置。没有该服务或版本不符时工具报错。
 * - 提交前经 DSH 审批服务（`ctx.approval`）请求一次性授权；dsh_channels 把它
 *   显示为飞书决策卡片，DSH Web 显示为审批提示。只有 `allowed-once` 才提交；
 *   没有审批服务时工具报错，不提交。
 * - 子会话中不提供本工具。
 *
 * @module dsh-logalyze/skill-update/tool
 */

import { randomBytes } from 'node:crypto'
import { rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { CommitAuthor } from 'dsh-repo/contract'
import { z } from 'zod'
import { describeIssue } from '../config.ts'
import { isDelegatedAgent } from '../dispatch/tool.ts'
import type { ContentBlock, HostApproval, ToolDefinition, ToolRunContext } from '../host.ts'
import { messageOf, repoErrorCode, requireRepos } from '../repos/lookup.ts'
import type { RepoRegistry } from '../repos/registry.ts'
import type { AppManifest, EditableSettings } from '../settings/contract.ts'
import { prepareChange } from './change.ts'
import type { FileStat, PreparedChange } from './change.ts'
import { DIFF_FILE, FILES_DIR, PROPOSAL_DIR, ProposalError, readProposal, REASON_FILE } from './proposal.ts'
import type { ProposedFile } from './proposal.ts'

/** Model-facing tool name. */
export const PROPOSE_TOOL_NAME = 'logalyze_propose_skill'

/** Longest accepted one-line summary; it becomes the commit subject and merge request title. */
export const MAX_SUMMARY_CHARS = 120

/** Dispatched tasks remembered for submission; older ones are forgotten first. */
const MAX_REMEMBERED_TASKS = 256

/** Characters of the reason shown on an approval prompt. */
const REASON_PREVIEW_CHARS = 300

/** Characters of the reason sent as the merge request description; the commit message keeps all of it. */
const REASON_DESCRIPTION_CHARS = 2000

/** A dispatched task as the dispatch tool recorded it. */
export interface DispatchedTask {
  /** Absolute run directory of the task. */
  readonly workDir: string
  /** Session that dispatched the task. */
  readonly sessionId: string
  readonly app: AppManifest
  /** Repository address the application came from. */
  readonly url: string
  /** Commit the child analyzed. */
  readonly commit: string
}

/** A task's proposal as the dispatch result reports it. */
export type ProposalCheck =
  | { readonly ok: true; readonly files: readonly FileStat[]; readonly diffPath: string }
  | { readonly ok: false; readonly error: string }

/** How one submission ended. */
export type ProposeStatus = 'opened' | 'pushed' | 'exists' | 'rejected' | 'cancelled' | 'unavailable'

/** Canonical tool value. */
export interface ProposeValue {
  status: ProposeStatus
  app: string
  repo: string
  /** New branch the change was or would be committed to. */
  branch: string
  /** Branch the merge request targets. */
  target: string
  files: FileStat[]
  /** Diff file in the task's run directory. */
  diffPath: string
  mergeRequestUrl?: string
  /** Why the merge request was not created; only with `pushed`. */
  mergeRequestError?: string
}

const argsSchema = z.object({
  workDir: z.string().trim().min(1, 'workDir 不能为空'),
  summary: z.string().trim().min(1, 'summary 不能为空').max(MAX_SUMMARY_CHARS, `summary 不能超过 ${MAX_SUMMARY_CHARS} 个字符`)
    .refine(value => !/[\r\n]/.test(value), 'summary 只能是一行'),
}).strict()

const PARAMETERS: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['workDir', 'summary'],
  properties: {
    workDir: { type: 'string', description: '派发结果中带有 SKILL 修改提议的任务运行目录（绝对路径）。' },
    summary: { type: 'string', description: `一句话说明改了什么，用作提交标题和合并请求标题，不超过 ${MAX_SUMMARY_CHARS} 个字符。` },
  },
}

const FILE_STAT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'added', 'removed'],
  properties: { path: { type: 'string' }, added: { type: 'number' }, removed: { type: 'number' } },
} as const

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'app', 'repo', 'branch', 'target', 'files', 'diffPath'],
  properties: {
    status: { type: 'string', enum: ['opened', 'pushed', 'exists', 'rejected', 'cancelled', 'unavailable'] },
    app: { type: 'string' },
    repo: { type: 'string' },
    branch: { type: 'string' },
    target: { type: 'string' },
    files: { type: 'array', items: FILE_STAT_SCHEMA },
    diffPath: { type: 'string' },
    mergeRequestUrl: { type: 'string' },
    mergeRequestError: { type: 'string' },
  },
} as const

/**
 * Render line counts as `path（+a −r）`, separated by `、`.
 * @param files - changed files.
 * @returns one line.
 */
export function describeFiles(files: readonly FileStat[]): string {
  return files.map(file => `${file.path}（+${file.added} −${file.removed}）`).join('、')
}

/**
 * Model-facing rendering of a submission.
 * @param value - canonical value.
 * @returns text content.
 */
export function renderProposeValue(value: ProposeValue): ContentBlock[] {
  const where = `${value.repo} 的分支 ${value.branch}（目标 ${value.target}）`
  const text = {
    opened: `已提交到 ${where} 并创建合并请求：${value.mergeRequestUrl ?? ''}`,
    pushed: `已提交到 ${where}，但创建合并请求失败（${value.mergeRequestError ?? '未知原因'}）；请在代码托管平台上从该分支手动创建。`,
    exists: `${where} 已存在，同一改动可能已经提交过，本次没有提交。`,
    rejected: '授权被拒绝，没有提交：用户拒绝了这次修改，或会话的审批策略为 never（例如「完全访问」权限模式）。',
    cancelled: '授权请求被撤回，没有提交。',
    unavailable: '当前没有可以回答授权请求的界面，没有提交。',
  }[value.status]
  return [{ type: 'text', text: `${text}\n改动：${describeFiles(value.files)}\ndiff：${value.diffPath}` }]
}

/** Collaborators of the submission tool. */
export interface SkillUpdaterDeps {
  readonly registry: RepoRegistry
  settings(): EditableSettings
  readonly author?: CommitAuthor
  /** DSH's approval service, when the composition has one. */
  approval(): HostApproval | undefined
  /** What `ctx.get('dshRepos')` returns now. */
  repos(): unknown
}

/**
 * Write a file in an agent-writable directory without following whatever
 * entry the agent left at its path: the content goes to a new file created
 * exclusively, which then replaces the directory entry.
 */
async function replaceFile(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temporary, content, { flag: 'wx' })
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

function skillDirOf(app: AppManifest): string {
  return `.dsh/skills/${app.skill}`
}

/** Remembers dispatched tasks, checks their proposals, and submits them. */
export class SkillUpdater {
  private readonly tasks = new Map<string, DispatchedTask>()

  /** @param deps - registry, settings, approval, and `dshRepos` access. */
  constructor(private readonly deps: SkillUpdaterDeps) {}

  /** @returns whether proposals are enabled in the current settings. */
  enabled(): boolean {
    return this.deps.settings().skillUpdates.enabled
  }

  /**
   * Remember a finished task and check the proposal it wrote, writing the
   * diff next to it.
   * @param task - the dispatched task.
   * @returns the check, or undefined when the task wrote no proposal.
   */
  async inspect(task: DispatchedTask): Promise<ProposalCheck | undefined> {
    this.remember(task)
    try {
      const prepared = await this.prepare(task)
      if (prepared === undefined) return undefined
      return { ok: true, files: prepared.change.files, diffPath: prepared.diffPath }
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
  }

  private remember(task: DispatchedTask): void {
    this.tasks.delete(task.workDir)
    this.tasks.set(task.workDir, task)
    for (const key of this.tasks.keys()) {
      if (this.tasks.size <= MAX_REMEMBERED_TASKS) break
      this.tasks.delete(key)
    }
  }

  /**
   * Read the proposal, build its tree, and write the diff file.
   * @returns undefined when the task wrote no proposal.
   * @throws ProposalError, or an error when dsh-repo is unavailable or the mirror cannot be read.
   */
  private async prepare(task: DispatchedTask, signal?: AbortSignal): Promise<{ reason: string; files: readonly ProposedFile[]; change: PreparedChange; target: string; diffPath: string } | undefined> {
    const proposal = await readProposal(task.workDir, this.deps.settings().skillUpdates)
    if (proposal === undefined) return undefined
    const target = this.deps.registry.branchOf(task.url)
    const change = await prepareChange(requireRepos(this.deps.repos()), { url: task.url, base: task.commit, skillDir: skillDirOf(task.app) }, proposal.files, signal)
    if (change.files.length === 0) throw new ProposalError(`提议的文件与提交 ${task.commit.slice(0, 12)} 中的 SKILL 相同，没有改动`)
    const diffPath = join(task.workDir, DIFF_FILE)
    await replaceFile(diffPath, change.diff)
    return { reason: proposal.reason, files: proposal.files, change, target, diffPath }
  }

  /**
   * Build the tool definition.
   * @returns the registration.
   */
  definition(): ToolDefinition<ProposeValue> {
    return {
      name: PROPOSE_TOOL_NAME,
      description: '观象：把派发结果中某个应用的 SKILL 修改提议提交为合并请求。工具先请求用户授权，批准后提交到新分支并创建合并请求，不会直接改动默认分支。'
        + '仅在派发结果标出了 SKILL 修改提议时使用；不要自己用 git 推送。',
      parameters: PARAMETERS,
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => renderProposeValue(value),
      },
      isConcurrencySafe: () => false,
      execute: (args, exec) => this.execute(args, exec),
    }
  }

  /**
   * Submit one proposal.
   * @param rawArgs - model arguments.
   * @param exec - execution context of the calling agent.
   * @returns how the submission ended.
   * @throws when the arguments, task, proposal, approval service, or `dshRepos` service are unusable, or the commit fails; nothing is committed then.
   */
  async execute(rawArgs: unknown, exec: ToolRunContext): Promise<ProposeValue> {
    const parsed = argsSchema.safeParse(rawArgs)
    if (!parsed.success) throw new Error(`${PROPOSE_TOOL_NAME} 参数不合法：${describeIssue(parsed.error)}`)
    const { summary } = parsed.data
    const agent = exec.agent
    if (agent === undefined) throw new Error(`${PROPOSE_TOOL_NAME} 需要由 Agent 调用`)
    if (isDelegatedAgent(agent)) throw new Error(`${PROPOSE_TOOL_NAME} 不能在子 Agent 中调用`)
    if (!this.enabled()) throw new Error('观象的 SKILL 修改提议未开启（设置面板「高级」→「SKILL 改进」）')
    const task = this.tasks.get(resolve(parsed.data.workDir))
    if (task === undefined) throw new Error(`${parsed.data.workDir} 不是本次 DSH 运行中观象派发任务的运行目录；DSH 重启后需要重新分析`)
    if (task.sessionId !== agent.session.header.id) throw new Error(`${parsed.data.workDir} 不是当前会话派发的任务`)
    const approval = this.deps.approval()
    if (approval === undefined) throw new Error('当前 DSH 组合没有审批服务（@deepseek-ai/dsh-user-approval），观象不会在未经授权时提交')
    const repos = requireRepos(this.deps.repos())

    let prepared: Awaited<ReturnType<SkillUpdater['prepare']>>
    try {
      prepared = await this.prepare(task, exec.signal)
    } catch (error) {
      exec.signal.throwIfAborted()
      throw error
    }
    if (prepared === undefined) throw new Error(`${task.workDir} 中没有 SKILL 修改提议（${PROPOSAL_DIR}/${REASON_FILE} 与 ${PROPOSAL_DIR}/${FILES_DIR}/）`)
    const { change, target, diffPath, reason } = prepared
    const branch = `logalyze/skill-${task.app.id}-${change.digest.slice(0, 10)}`
    const base = { app: task.app.id, repo: task.url, branch, target, files: [...change.files], diffPath }

    if (await repos.getBranch(task.url, branch, { signal: exec.signal }) !== undefined) return { ...base, status: 'exists' }

    const preview = reason.replace(/\s+/g, ' ').slice(0, REASON_PREVIEW_CHARS)
    const zh = `观象将在 ${task.url} 提交新分支 ${branch}，并创建合并请求合入 ${target}。改动：${describeFiles(change.files)}。摘要：${summary}。理由：${preview}`
    const en = `Logalyze will commit branch ${branch} to ${task.url} and open a merge request into ${target}. Files: ${change.files.map(file => file.path).join(', ')}. Summary: ${summary}`
    const outcome = await approval.request({
      agent,
      toolName: PROPOSE_TOOL_NAME,
      ...exec.callId === undefined ? {} : { callId: exec.callId },
      reason: zh,
      displayReason: { en, zh },
      signal: exec.signal,
    })
    if (outcome === 'cancelled') exec.signal.throwIfAborted()
    if (outcome !== 'allowed-once') return { ...base, status: outcome }

    const message = `${summary}\n\n${reason}\n\nProposed-by: 观象 Logalyze\nAnalyzed-commit: ${task.commit}\nSession: ${task.sessionId}\n`
    const description = `由观象在日志分析中提出（应用 ${task.app.id}，分析提交 ${task.commit.slice(0, 12)}，会话 ${task.sessionId}）。理由：${reason.slice(0, REASON_DESCRIPTION_CHARS)}`
    // Only files that differ from the analyzed commit; an unchanged one would be an empty update.
    const changed = new Set(change.files.map(file => file.path))
    const files = prepared.files
      .map(file => ({ action: 'write' as const, path: `${skillDirOf(task.app)}/${file.path}`, content: file.content }))
      .filter(file => changed.has(file.path))
    exec.signal.throwIfAborted()
    try {
      await repos.commitFiles(task.url, {
        branch,
        baseSha: task.commit,
        newBranch: true,
        message,
        files,
        ...this.deps.author === undefined ? {} : { author: this.deps.author },
        signal: exec.signal,
      })
    } catch (error) {
      if (repoErrorCode(error) === 'conflict') return { ...base, status: 'exists' }
      throw error
    }
    try {
      const opened = await repos.createChange(task.url, { title: summary, body: description, sourceBranch: branch, targetBranch: target, signal: exec.signal })
      return { ...base, status: 'opened', mergeRequestUrl: opened.webUrl }
    } catch (error) {
      // The branch exists now; report it so the user can open the request by hand.
      return { ...base, status: 'pushed', mergeRequestError: messageOf(error) }
    }
  }
}
