/**
 * `guanxiang_dispatch` 派发工具：校验应用与日志，下载 URL 日志，按应用并行
 * 启动子 Agent（工作目录为应用仓库），等待全部结束后一次返回各应用结论。
 *
 * - 应用 id 必须与注册表一一对应且仓库可用，否则整次调用被拒绝、不启动任何子 Agent。
 * - 日志一律以绝对路径交给子 Agent；URL 先下载到本次运行目录
 *   `<父会话目录>/.guanxiang/runs/<runId>/<序号>-<应用 id>/`，该目录也是子 Agent
 *   解压日志的可写目录。
 * - 超时（`dispatchTimeoutMs`）或调用被取消时停止全部仍在运行的子 Agent。
 * - 子会话（委派深度大于 0）中不提供本工具。
 *
 * @module dsh-guanxiang/dispatch/tool
 */

import { randomBytes } from 'node:crypto'
import { mkdir, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import { describeIssue } from '../config.ts'
import type { Agent, ContentBlock, SubagentActivation, SubagentService, ToolDefinition, ToolRunContext, WorkingDirectoryService } from '../host.ts'
import type { RepoRegistry } from '../repos/registry.ts'
import type { EditableSettings } from '../settings/contract.ts'
import { admitUrl, downloadLog, fileNameFor } from './download.ts'
import { renderChildPrompt } from './prompt.ts'
import type { ChildLog } from './prompt.ts'

/** Model-facing tool name. */
export const DISPATCH_TOOL_NAME = 'guanxiang_dispatch'

const logSchema = z.union([
  z.object({ path: z.string().trim().min(1), filter: z.string().trim().min(1).optional() }).strict(),
  z.object({ url: z.string().trim().min(1), filter: z.string().trim().min(1).optional() }).strict(),
], { error: '每个日志项必须是 { path } 或 { url } 之一（可带 filter）' })

const argsSchema = z.object({
  tasks: z.array(z.object({
    app: z.string().trim().min(1),
    question: z.string().trim().min(1, 'question 不能为空'),
    logs: z.array(logSchema).min(1, '每个任务至少需要一份日志'),
  }).strict()).min(1, '至少需要一个任务'),
}).strict()

/** Validated dispatch arguments. */
export type DispatchArgs = z.output<typeof argsSchema>

/** Terminal state of one child analysis. */
export type TaskStatus = 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal' | 'timeout' | 'failed' | (string & {})

/** One application's outcome. */
export interface TaskResult {
  app: string
  name: string
  status: TaskStatus
  childId?: string
  /** The child's final answer text (possibly partial when not completed). */
  output: string
  /** Failure detail separate from the child's own words. */
  diagnostic?: string
  /** Writable run directory of this task. */
  workDir: string
  /** Absolute log paths handed to the child. */
  logs: string[]
}

/** Canonical tool value. */
export interface DispatchValue {
  runId: string
  runDir: string
  results: TaskResult[]
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['runId', 'runDir', 'results'],
  properties: {
    runId: { type: 'string' },
    runDir: { type: 'string' },
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['app', 'name', 'status', 'output', 'workDir', 'logs'],
        properties: {
          app: { type: 'string' },
          name: { type: 'string' },
          status: { type: 'string' },
          childId: { type: 'string' },
          output: { type: 'string' },
          diagnostic: { type: 'string' },
          workDir: { type: 'string' },
          logs: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const

const STATUS_LABELS: Record<string, string> = {
  completed: '完成',
  aborted: '已取消',
  error: '出错',
  'max-tokens': '输出超长被截断',
  refusal: '拒绝执行',
  timeout: '超时被停止',
  failed: '未能启动',
}

/**
 * Model-facing rendering of a dispatch value.
 * @param value - canonical value.
 * @returns text content.
 */
export function renderDispatchValue(value: DispatchValue): ContentBlock[] {
  const sections = value.results.map((result) => {
    const label = STATUS_LABELS[result.status] ?? result.status
    const body = result.output.trim() === '' ? '（子 Agent 没有给出结论）' : result.output.trim()
    const diagnostic = result.diagnostic === undefined ? '' : `\n\n诊断：${result.diagnostic}`
    return `### ${result.name}（${result.app}）— ${label}\n\n${body}${diagnostic}`
  })
  return [{ type: 'text', text: `观象派发 ${value.runId} 结束，运行目录 ${value.runDir}。\n\n${sections.join('\n\n')}` }]
}

/**
 * Raw JSON-schema parameters. Application ids and the task ceiling change
 * with the registry and settings, so the entry skill lists them and
 * `execute` enforces them; the definition itself stays fixed for the
 * plugin's lifetime.
 */
export const DISPATCH_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['tasks'],
  properties: {
    tasks: {
      type: 'array',
      description: '要分析的任务，每个应用一项，项数不超过入口 SKILL 给出的上限。',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['app', 'question', 'logs'],
        properties: {
          app: { type: 'string', description: '应用 id，取自入口 SKILL 的应用目录。' },
          question: { type: 'string', description: '给子 Agent 的完整问题：现象、时间范围、关键标识与用户原话要点。子 Agent 看不到当前对话。' },
          logs: {
            type: 'array',
            description: '日志位置。{ "path": 本机绝对路径 } 用于附件和本机文件；{ "url": 下载地址 } 用于对象存储链接（仅白名单域名）。',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', description: '本机日志文件或目录的绝对路径。' },
                url: { type: 'string', description: '日志下载地址。' },
                filter: { type: 'string', description: '混合日志中本应用相关行的识别方式，例如 tag 或进程名。' },
              },
            },
          },
        },
      },
    },
  },
}

/** Collaborators of the dispatch tool. */
export interface DispatchDeps {
  readonly registry: RepoRegistry
  readonly subagents: SubagentService
  /** Current effective settings. */
  settings(): EditableSettings
  /** Registered `ctx.subagents` provider name. */
  readonly provider: string
  /** The working-directory service, when the composition has one. */
  workingDirectory(): WorkingDirectoryService | undefined
  readonly fetch?: typeof fetch
  readonly now?: () => Date
}

/**
 * Whether a session is a delegated child, where the tool is not offered.
 * @param agent - calling agent.
 * @returns whether its delegation depth is above zero.
 */
export function isDelegatedAgent(agent: Agent): boolean {
  return (agent.session.header.delegationDepth ?? 0) > 0
}

function newRunId(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${stamp}-${randomBytes(3).toString('hex')}`
}

function isInside(child: string, parent: string): boolean {
  const path = relative(parent, child)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

function textOf(blocks: readonly ContentBlock[]): string {
  return blocks.flatMap(block => block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n').trim()
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Runs dispatches; one instance serves every registration of the tool. */
export class Dispatcher {
  /** @param deps - registry, subagent service, settings, and I/O seams. */
  constructor(private readonly deps: DispatchDeps) {}

  /**
   * Build the tool definition.
   * @returns the registration.
   */
  definition(): ToolDefinition<DispatchValue> {
    return {
      name: DISPATCH_TOOL_NAME,
      description: '观象：把日志分析任务派发给在对应应用代码仓库中工作的子 Agent，并等待全部完成后返回各应用的结论。'
        + '仅在 /guanxiang 入口 SKILL 的流程中使用；一次调用包含所有任务。',
      parameters: DISPATCH_PARAMETERS,
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => renderDispatchValue(value),
      },
      isConcurrencySafe: () => false,
      execute: (args, exec) => this.execute(args, exec),
    }
  }

  /**
   * Run one dispatch.
   * @param rawArgs - model arguments.
   * @param exec - execution context of the calling agent.
   * @returns every task's outcome.
   * @throws when arguments, applications, logs, or downloads are invalid; nothing is started then.
   */
  async execute(rawArgs: unknown, exec: ToolRunContext): Promise<DispatchValue> {
    const parsed = argsSchema.safeParse(rawArgs)
    if (!parsed.success) throw new Error(`${DISPATCH_TOOL_NAME} 参数不合法：${describeIssue(parsed.error)}`)
    const { tasks } = parsed.data
    const parent = exec.agent
    if (parent === undefined) throw new Error(`${DISPATCH_TOOL_NAME} 需要由 Agent 调用`)
    if (isDelegatedAgent(parent)) throw new Error(`${DISPATCH_TOOL_NAME} 不能在子 Agent 中调用`)
    const settings = this.deps.settings()
    if (tasks.length > settings.maxAppsPerRequest) {
      throw new Error(`一次最多派发 ${settings.maxAppsPerRequest} 个任务，本次有 ${tasks.length} 个；请合并或分批`)
    }
    const projectDir = parent.session.header.cwd
    if (projectDir === undefined) throw new Error('当前会话没有项目目录，无法创建运行目录')
    const effectiveDir = await this.deps.workingDirectory()?.ensure(parent, exec.signal) ?? projectDir
    const baseDir = isInside(effectiveDir, projectDir) ? effectiveDir : projectDir

    const sources = await Promise.all(tasks.map(task => Promise.all(task.logs.map(async (log) => {
      if ('url' in log) return { url: admitUrl(log.url, settings.download).href, filter: log.filter }
      const path = resolve(effectiveDir, log.path)
      try {
        await stat(path)
      } catch (error) {
        throw new Error(`日志路径不可读：${path}（${(error as NodeJS.ErrnoException).code ?? messageOf(error)}）`)
      }
      return { path, filter: log.filter }
    }))))

    const lease = await this.deps.registry.acquire(tasks.map(task => task.app))
    try {
      exec.signal.throwIfAborted()
      const runId = newRunId(this.deps.now?.() ?? new Date())
      const runDir = join(baseDir, '.guanxiang', 'runs', runId)
      const prepared = await Promise.all(tasks.map(async (task, index) => {
        const ready = lease.apps.get(task.app)
        if (ready === undefined) throw new Error(`应用「${task.app}」不可用`)
        const workDir = join(runDir, `${index + 1}-${task.app}`)
        await mkdir(workDir, { recursive: true })
        const logs: ChildLog[] = []
        for (const [position, source] of (sources[index] ?? []).entries()) {
          const filter = source.filter === undefined ? {} : { filter: source.filter }
          if (source.path !== undefined) {
            logs.push({ path: source.path, ...filter })
            continue
          }
          const url = new URL(source.url)
          const name = `${position + 1}-${fileNameFor(url, 'log')}`
          const file = await downloadLog(source.url, workDir, name, settings.download, exec.signal, this.deps.fetch)
          logs.push({ path: file.path, url: source.url, ...filter })
        }
        return { task, ready, workDir, logs }
      }))
      return { runId, runDir, results: await this.runChildren(parent, prepared, settings, exec.signal) }
    } finally {
      lease.release()
    }
  }

  private async runChildren(
    parent: Agent,
    prepared: readonly { task: DispatchArgs['tasks'][number]; ready: { app: import('../settings/contract.ts').AppManifest; dir: string; commit: string }; workDir: string; logs: ChildLog[] }[],
    settings: EditableSettings,
    signal: AbortSignal,
  ): Promise<TaskResult[]> {
    const deadline = AbortSignal.timeout(settings.dispatchTimeoutMs)
    const stop = AbortSignal.any([signal, deadline])
    const maxDepth = this.deps.subagents.resolveMaxDepth()
    const activations: (SubagentActivation | undefined)[] = []
    const results = await Promise.all(prepared.map(async ({ task, ready, workDir, logs }, index): Promise<TaskResult> => {
      const base = { app: ready.app.id, name: ready.app.name, workDir, logs: logs.map(log => log.path) }
      let activation: SubagentActivation
      try {
        activation = await this.deps.subagents.startActivation({
          provider: this.deps.provider,
          label: `${ready.app.name}分析`,
          request: {
            cwd: ready.dir,
            prompt: [{ type: 'text', text: renderChildPrompt({ app: ready.app, commit: ready.commit, question: task.question, logs, workDir }) }],
            parent,
            ...maxDepth === undefined ? {} : { maxDepth },
          },
          signal: stop,
          delivery: 'caller',
        })
      } catch (error) {
        return { ...base, status: stop.aborted && !signal.aborted ? 'timeout' : 'failed', output: '', diagnostic: messageOf(error) }
      }
      activations[index] = activation
      const stopped = new Promise<'stopped'>((resolveStop) => {
        if (stop.aborted) resolveStop('stopped')
        else stop.addEventListener('abort', () => { resolveStop('stopped') }, { once: true })
      })
      try {
        const outcome = await Promise.race([activation.result, stopped])
        if (outcome === 'stopped') {
          return { ...base, childId: activation.childId, status: signal.aborted ? 'aborted' : 'timeout', output: '', diagnostic: signal.aborted ? '派发被取消' : `超过派发等待上限 ${settings.dispatchTimeoutMs} ms` }
        }
        return {
          ...base,
          childId: activation.childId,
          status: outcome.stopReason,
          output: textOf(outcome.output),
          ...outcome.diagnostic === undefined ? {} : { diagnostic: outcome.diagnostic },
        }
      } catch (error) {
        return { ...base, childId: activation.childId, status: 'error', output: '', diagnostic: messageOf(error) }
      }
    }))
    // Activations are disposed in every outcome: after a result this releases
    // the child's resources, after a timeout or cancellation it stops the child.
    await Promise.all(activations.map(async (activation) => {
      if (activation === undefined) return
      try {
        await activation.dispose()
      } catch (error) {
        const result = results.find(entry => entry.childId === activation.childId)
        if (result !== undefined) result.diagnostic = [result.diagnostic, `子 Agent 清理失败：${messageOf(error)}`].filter(Boolean).join('；')
      }
    }))
    signal.throwIfAborted()
    return results
  }
}
