/**
 * 子 Agent 写在运行目录里的 SKILL 修改提议：`skill-proposal/reason.md` 说明
 * 理由，`skill-proposal/files/` 按相对路径存放应用 SKILL 目录
 * `.dsh/skills/<skill>/` 下要新增或修改的完整文件。
 *
 * 运行目录对 Agent 可写，所以这里读到的一切都按不可信输入校验：只接受普通
 * 文件和目录（不跟随符号链接）、受限的文件名、UTF-8 文本、文件数与大小上限。
 *
 * @module dsh-guanxiang/skill-update/proposal
 */

import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { disablesUserInvocation } from '../repos/manifest.ts'
import type { SkillUpdateSettings } from '../settings/contract.ts'

/** Proposal directory inside a task's run directory. */
export const PROPOSAL_DIR = 'skill-proposal'

/** Reason file inside {@link PROPOSAL_DIR}. */
export const REASON_FILE = 'reason.md'

/** Directory inside {@link PROPOSAL_DIR} mirroring `.dsh/skills/<skill>/`. */
export const FILES_DIR = 'files'

/** Diff the plugin writes next to the proposal, for the user to read. */
export const DIFF_FILE = 'skill-proposal.diff'

const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/
const decoder = new TextDecoder('utf-8', { fatal: true })

/** A proposal that cannot be submitted, with a reason the model and user can act on. */
export class ProposalError extends Error {}

/** One file of a proposal, by its path relative to the skill directory. */
export interface ProposedFile {
  readonly path: string
  readonly content: string
}

/** A validated proposal. */
export interface Proposal {
  readonly reason: string
  readonly files: readonly ProposedFile[]
}

async function kindOf(path: string): Promise<'missing' | 'directory' | 'file' | 'other'> {
  try {
    const info = await lstat(path)
    return info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }
}

async function readText(path: string, label: string, maxBytes: number): Promise<string> {
  const info = await lstat(path)
  if (info.size > maxBytes) throw new ProposalError(`${label} 有 ${info.size} 字节，超过上限 ${maxBytes}`)
  const bytes = await readFile(path)
  if (bytes.length > maxBytes) throw new ProposalError(`${label} 超过大小上限 ${maxBytes} 字节`)
  let text: string
  try {
    text = decoder.decode(bytes)
  } catch {
    // TextDecoder reports only that the bytes are not UTF-8.
    throw new ProposalError(`${label} 不是 UTF-8 文本`)
  }
  if (text.includes('\u0000')) throw new ProposalError(`${label} 包含 NUL 字符，不是文本文件`)
  return text
}

/**
 * Read and validate the proposal of one task.
 * @param workDir - the task's run directory.
 * @param limits - file count and size ceilings.
 * @returns the proposal, or undefined when the task wrote none.
 * @throws ProposalError when the proposal exists but cannot be submitted.
 */
export async function readProposal(workDir: string, limits: Pick<SkillUpdateSettings, 'maxFiles' | 'maxFileBytes'>): Promise<Proposal | undefined> {
  const root = join(workDir, PROPOSAL_DIR)
  const rootKind = await kindOf(root)
  if (rootKind === 'missing') return undefined
  if (rootKind !== 'directory') throw new ProposalError(`${PROPOSAL_DIR} 必须是目录`)

  const reasonPath = join(root, REASON_FILE)
  if (await kindOf(reasonPath) !== 'file') throw new ProposalError(`缺少 ${PROPOSAL_DIR}/${REASON_FILE}（修改理由）`)
  const reason = (await readText(reasonPath, `${PROPOSAL_DIR}/${REASON_FILE}`, limits.maxFileBytes)).trim()
  if (reason === '') throw new ProposalError(`${PROPOSAL_DIR}/${REASON_FILE} 不能为空`)

  const filesRoot = join(root, FILES_DIR)
  if (await kindOf(filesRoot) !== 'directory') throw new ProposalError(`缺少 ${PROPOSAL_DIR}/${FILES_DIR}/（修改后的 SKILL 文件）`)
  const files: ProposedFile[] = []
  const walk = async (dir: string, prefix: readonly string[]): Promise<void> => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const segments = [...prefix, entry.name]
      const relative = segments.join('/')
      if (!SEGMENT.test(entry.name)) throw new ProposalError(`文件名不合法：${relative}（只允许字母、数字、. _ -，且不能以 . 或 - 开头）`)
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(path, segments)
        continue
      }
      if (!entry.isFile()) throw new ProposalError(`${relative} 不是普通文件（不接受符号链接等）`)
      if (files.length >= limits.maxFiles) throw new ProposalError(`文件数超过上限 ${limits.maxFiles}`)
      files.push({ path: relative, content: await readText(path, relative, limits.maxFileBytes) })
    }
  }
  await walk(filesRoot, [])
  if (files.length === 0) throw new ProposalError(`${PROPOSAL_DIR}/${FILES_DIR}/ 中没有文件`)
  const skill = files.find(file => file.path === 'SKILL.md')
  if (skill !== undefined && disablesUserInvocation(skill.content)) {
    throw new ProposalError('SKILL.md 不能设置 user-invocable: false，否则派发时无法用 /<skill> 加载')
  }
  return { reason, files }
}
