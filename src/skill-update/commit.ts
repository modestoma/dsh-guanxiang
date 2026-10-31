/**
 * 经用户授权后把一组文件提交到新分支并创建合并请求。SKILL 修改提议与接入初稿
 * 共用这一流程：
 *
 * - 新分支已存在时不请求授权、不提交（同一改动可能已经提交过）。
 * - 经 DSH 审批服务请求一次性授权，只有 `allowed-once` 才提交；授权期间出现的
 *   同名分支由 `newBranch: true` 拒绝，不会提交到已有分支。
 * - 提交以基准提交为父提交；分支创建后合并请求失败时报告 `pushed`，由用户手动创建。
 *
 * @module dsh-logalyze/skill-update/commit
 */

import type { Agent, HostApproval, ToolRunContext } from '../host.ts'
import type { CommitAuthor, DshRepos } from '../repos/contract.ts'
import { messageOf, repoErrorCode } from '../repos/lookup.ts'

/** How one submission ended. */
export type SubmitStatus = 'opened' | 'pushed' | 'exists' | 'rejected' | 'cancelled' | 'unavailable'

/** One submission. */
export interface SubmitRequest {
  readonly repos: DshRepos
  readonly approval: HostApproval
  /** The calling top-level agent. */
  readonly agent: Agent
  readonly exec: ToolRunContext
  /** Tool the approval request is about. */
  readonly toolName: string
  /** Repository address. */
  readonly url: string
  /** Full commit id the new branch starts from. */
  readonly base: string
  /** New branch. */
  readonly branch: string
  /** Branch the merge request targets. */
  readonly target: string
  /** Files to write, by repository-relative path; only files that differ from {@link base}. */
  readonly files: readonly { readonly action: 'write'; readonly path: string; readonly content: string }[]
  readonly message: string
  readonly title: string
  readonly body: string
  readonly author?: CommitAuthor
  /** Approval prompt text. */
  readonly prompt: { readonly zh: string; readonly en: string }
}

/** Outcome of one submission. */
export interface SubmitOutcome {
  readonly status: SubmitStatus
  readonly mergeRequestUrl?: string
  /** Why the merge request was not created; only with `pushed`. */
  readonly mergeRequestError?: string
}

/**
 * Ask once, then commit and open the merge request.
 * @param request - repository, change, and approval context.
 * @returns how the submission ended.
 * @throws the cancellation reason when the turn is cancelled, or the commit failure; the branch is not created then.
 */
export async function submitChange(request: SubmitRequest): Promise<SubmitOutcome> {
  const { repos, exec, url, branch } = request
  if (await repos.getBranch(url, branch, { signal: exec.signal }) !== undefined) return { status: 'exists' }
  const outcome = await request.approval.request({
    agent: request.agent,
    toolName: request.toolName,
    ...exec.callId === undefined ? {} : { callId: exec.callId },
    reason: request.prompt.zh,
    displayReason: { en: request.prompt.en, zh: request.prompt.zh },
    signal: exec.signal,
  })
  if (outcome === 'cancelled') exec.signal.throwIfAborted()
  if (outcome !== 'allowed-once') return { status: outcome }
  exec.signal.throwIfAborted()
  try {
    await repos.commitFiles(url, {
      branch,
      baseSha: request.base,
      newBranch: true,
      message: request.message,
      files: request.files,
      ...request.author === undefined ? {} : { author: request.author },
      signal: exec.signal,
    })
  } catch (error) {
    if (repoErrorCode(error) === 'conflict') return { status: 'exists' }
    throw error
  }
  try {
    const opened = await repos.createChange(url, { title: request.title, body: request.body, sourceBranch: branch, targetBranch: request.target, signal: exec.signal })
    return { status: 'opened', mergeRequestUrl: opened.webUrl }
  } catch (error) {
    // The branch exists now; report it so the user can open the request by hand.
    return { status: 'pushed', mergeRequestError: messageOf(error) }
  }
}
