/**
 * 本机 git 命令的调用封装：沿用本机已有凭据（SSH key 或 credential helper），
 * 禁止交互式提示，避免后台拉取卡在密码输入上。
 *
 * @module dsh-guanxiang/repos/git
 */

import { execFile } from 'node:child_process'

/** A failed git command with its combined output. */
export class GitError extends Error {
  /**
   * @param args - git arguments that failed.
   * @param output - trimmed stderr (or stdout when stderr is empty).
   */
  constructor(readonly args: readonly string[], readonly output: string) {
    super(`git ${args.join(' ')} 失败：${output === '' ? '无输出' : output}`)
  }
}

/** Runs one git command and resolves its stdout. */
export type GitRunner = (args: readonly string[], options: { cwd?: string; timeoutMs: number }) => Promise<string>

/**
 * Environment for non-interactive git: no terminal prompts, and SSH in batch
 * mode unless the user configured their own SSH command.
 * @param env - base environment.
 * @returns environment for git child processes.
 */
export function gitEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env, GIT_TERMINAL_PROMPT: '0' }
  if (env.GIT_SSH_COMMAND === undefined && env.GIT_SSH === undefined) next.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes'
  return next
}

/**
 * Default runner backed by the `git` executable on PATH.
 * @param args - git arguments.
 * @param options - working directory and timeout.
 * @returns stdout.
 */
export const runGit: GitRunner = (args, options) => new Promise((resolve, reject) => {
  execFile('git', [...args], {
    cwd: options.cwd,
    env: gitEnvironment(),
    timeout: options.timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  }, (error, stdout, stderr) => {
    if (error === null) {
      resolve(stdout)
      return
    }
    const output = (stderr.trim() !== '' ? stderr : stdout).trim()
    const killed = (error as { killed?: boolean }).killed === true
    reject(new GitError(args, killed ? `超时（${options.timeoutMs} ms）后被终止${output === '' ? '' : `：${output}`}` : output || error.message))
  })
})
