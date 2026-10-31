/**
 * 检查 SKILL 修改：从 dsh-repo 镜像读取分析时的提交中 SKILL 目录的文件，与提议
 * 的文件比较，算出逐文件行数和 unified diff，不改动任何镜像或快照。提议内容的
 * 摘要用作新分支名，提交本身经 dsh-repo 完成。
 *
 * @module dsh-logalyze/skill-update/change
 */

import { createHash } from 'node:crypto'
import { createTwoFilesPatch, structuredPatch } from 'diff'
import type { DshRepoService } from 'dsh-repo/contract'
import type { ProposedFile } from './proposal.ts'

/** Line counts of one changed file. */
export interface FileStat {
  /** Path relative to the repository root. */
  readonly path: string
  readonly added: number
  readonly removed: number
}

/** A proposal compared with its base commit. */
export interface PreparedChange {
  readonly base: string
  /** Hexadecimal digest of the base commit and the changed files; names the branch. */
  readonly digest: string
  readonly files: readonly FileStat[]
  /** Unified diff from the base commit to the proposal, limited to the skill directory. */
  readonly diff: string
}

/** Where a proposal applies. */
export interface ChangeTarget {
  readonly url: string
  /** Commit the analysis ran on. */
  readonly base: string
  /** Skill directory relative to the repository root, `/`-separated. */
  readonly skillDir: string
}

/**
 * Compare the proposed files with the skill directory of the base commit.
 * @param repos - the `dshRepos` service holding the mirror.
 * @param target - repository, base commit, and skill directory.
 * @param files - proposed files relative to the skill directory.
 * @param signal - cancellation.
 * @returns per-file line counts, the diff, and the digest; `files` is empty when nothing changes.
 * @throws when a proposed path replaces a symbolic link, a submodule, or a directory, or the mirror cannot be read.
 */
export async function prepareChange(repos: DshRepoService, target: ChangeTarget, files: readonly ProposedFile[], signal?: AbortSignal): Promise<PreparedChange> {
  const { url, base, skillDir } = target
  const listing = await repos.listMirrorTree(url, base, skillDir, signal === undefined ? {} : { signal })
  const types = new Map(listing.map(entry => [entry.path, entry.type]))
  const stats: FileStat[] = []
  const patches: string[] = []
  const digest = createHash('sha256').update(`${base}\n`)
  for (const file of [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    const path = `${skillDir}/${file.path}`
    const type = types.get(path)
    if (type === 'symlink') throw new Error(`${path} 在仓库中是符号链接，不能用提议覆盖`)
    if (type === 'dir' || type === 'submodule') throw new Error(`${path} 在仓库中是目录，不能用文件覆盖`)
    const before = type === 'file' ? await repos.readMirrorFile(url, base, path, signal === undefined ? {} : { signal }) ?? '' : undefined
    if (before === file.content) continue
    const structured = structuredPatch(path, path, before ?? '', file.content, undefined, undefined, { context: 3 })
    let added = 0
    let removed = 0
    for (const hunk of structured.hunks) {
      for (const line of hunk.lines) {
        if (line.startsWith('+')) added += 1
        else if (line.startsWith('-')) removed += 1
      }
    }
    stats.push({ path, added, removed })
    const header = `diff --git a/${path} b/${path}\n${before === undefined ? 'new file mode 100644\n' : ''}`
    const patch = createTwoFilesPatch(before === undefined ? '/dev/null' : `a/${path}`, `b/${path}`, before ?? '', file.content, undefined, undefined, { context: 3 })
    // jsdiff starts with an `Index:`-style separator line that git diffs do not have.
    patches.push(header + patch.replace(/^=+\n/, ''))
    digest.update(`${path}\0${file.content}\0`)
  }
  return { base, digest: digest.digest('hex'), files: stats, diff: patches.join('') }
}
