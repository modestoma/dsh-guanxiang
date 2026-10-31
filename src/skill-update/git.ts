/**
 * 在拉取仓库中用 git 底层命令检查 SKILL 修改：用临时索引文件在分析时的提交上
 * 替换文件、写出树对象，算出逐文件行数和 diff，不改动任何检出、快照或本地
 * 分支。树对象的前缀用作新分支名，提交本身经 dsh-repo 完成。
 *
 * @module dsh-guanxiang/skill-update/git
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GitRunner } from '../repos/git.ts'
import type { ProposedFile } from './proposal.ts'

/** Line counts of one changed file. */
export interface FileStat {
  /** Path relative to the repository root. */
  readonly path: string
  /** Added lines; undefined for a binary change. */
  readonly added?: number
  /** Removed lines; undefined for a binary change. */
  readonly removed?: number
}

/** A proposal turned into a tree object on top of its base commit. */
export interface PreparedChange {
  readonly base: string
  readonly tree: string
  readonly files: readonly FileStat[]
  /** Unified diff from the base commit to {@link tree}, limited to the skill directory. */
  readonly diff: string
}

/** git runner and the timeout of one command. */
export interface GitCommands {
  readonly git: GitRunner
  readonly timeoutMs: number
}

const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-renames']

/**
 * Write the proposed files over the skill directory of `base` into a new tree.
 * @param commands - git runner and timeout.
 * @param dir - repository directory whose object database receives the objects.
 * @param base - commit the analysis ran on.
 * @param skillDir - skill directory relative to the repository root, `/`-separated.
 * @param files - proposed files relative to `skillDir`.
 * @returns the tree, per-file line counts, and the diff; `files` is empty when nothing changes.
 * @throws when a proposed path replaces a symbolic link or a directory, or a git command fails.
 */
export async function prepareChange(commands: GitCommands, dir: string, base: string, skillDir: string, files: readonly ProposedFile[]): Promise<PreparedChange> {
  const { git, timeoutMs } = commands
  const scratch = await mkdtemp(join(tmpdir(), 'guanxiang-index-'))
  try {
    const env = { GIT_INDEX_FILE: join(scratch, 'index') }
    await git(['read-tree', base], { cwd: dir, timeoutMs, env })
    const listing = await git(['ls-tree', '-r', '-t', '-z', base, '--', `${skillDir}/`], { cwd: dir, timeoutMs })
    const modes = new Map<string, string>()
    for (const record of listing.split('\0')) {
      const tab = record.indexOf('\t')
      if (tab < 0) continue
      modes.set(record.slice(tab + 1), record.slice(0, record.indexOf(' ')))
    }
    for (const file of files) {
      const path = `${skillDir}/${file.path}`
      const existing = modes.get(path)
      if (existing === '120000') throw new Error(`${path} 在仓库中是符号链接，不能用提议覆盖`)
      if (existing === '040000') throw new Error(`${path} 在仓库中是目录，不能用文件覆盖`)
      const blob = (await git(['hash-object', '-w', '--stdin'], { cwd: dir, timeoutMs, input: file.content })).trim()
      await git(['update-index', '--add', '--cacheinfo', `${existing === '100755' ? '100755' : '100644'},${blob},${path}`], { cwd: dir, timeoutMs, env })
    }
    const tree = (await git(['write-tree'], { cwd: dir, timeoutMs, env })).trim()
    const numstat = await git(['diff', ...DIFF_FLAGS, '--numstat', base, tree, '--', `${skillDir}/`], { cwd: dir, timeoutMs })
    const stats = numstat.split('\n').filter(line => line !== '').map((line): FileStat => {
      const [added = '-', removed = '-', ...path] = line.split('\t')
      return { path: path.join('\t'), ...added === '-' ? {} : { added: Number(added) }, ...removed === '-' ? {} : { removed: Number(removed) } }
    })
    const diff = stats.length === 0 ? '' : await git(['diff', ...DIFF_FLAGS, base, tree, '--', `${skillDir}/`], { cwd: dir, timeoutMs })
    return { base, tree, files: stats, diff }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
