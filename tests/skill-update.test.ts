import { lstat, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { defaultsOf, resolveConfig } from '../src/config.ts'
import type { Agent, ApprovalOutcome, ApprovalRequest, HostApproval } from '../src/host.ts'
import { RepoRegistry } from '../src/repos/registry.ts'
import type { EditableSettings } from '../src/settings/contract.ts'
import { DIFF_FILE, readProposal } from '../src/skill-update/proposal.ts'
import { renderProposeValue, SkillUpdater } from '../src/skill-update/tool.ts'
import type { DispatchedTask } from '../src/skill-update/tool.ts'
import { createAppRepo, createRepos, tempDir } from './helpers.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

const LIMITS = { maxFiles: 4, maxFileBytes: 4096 }
const SKILL = '.dsh/skills/log-analysis/SKILL.md'
const MR_URL = 'https://gitlab.example.com/group/order-service/-/merge_requests/7'
const NEW_SKILL = '---\nname: log-analysis\ndescription: 新版\n---\n\n# 新版\n'

async function dir(): Promise<string> {
  const { dir: path, cleanup } = await tempDir()
  cleanups.push(cleanup)
  return path
}

async function writeProposal(workDir: string, files: Record<string, string>, reason = '日志格式里漏了 traceId 字段'): Promise<void> {
  await mkdir(join(workDir, 'skill-proposal', 'files'), { recursive: true })
  await writeFile(join(workDir, 'skill-proposal', 'reason.md'), reason)
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(workDir, 'skill-proposal', 'files', path)), { recursive: true })
    await writeFile(join(workDir, 'skill-proposal', 'files', path), content)
  }
}

describe('readProposal', () => {
  it('returns nothing when the task wrote no proposal', async () => {
    expect(await readProposal(await dir(), LIMITS)).toBeUndefined()
  })

  it('reads the reason and every file by its path under the skill directory', async () => {
    const workDir = await dir()
    await writeProposal(workDir, { 'SKILL.md': '# new', 'references/formats.md': 'a' }, '  理由  \n')
    expect(await readProposal(workDir, LIMITS)).toEqual({
      reason: '理由',
      files: [{ path: 'SKILL.md', content: '# new' }, { path: 'references/formats.md', content: 'a' }],
    })
  })

  it('rejects proposals that cannot be submitted', async () => {
    const cases: [string, (workDir: string) => Promise<void>, RegExp][] = [
      ['no reason', async (workDir) => { await writeProposal(workDir, { 'SKILL.md': 'x' }, '  ') }, /reason.md 不能为空/],
      ['no files', async (workDir) => { await writeProposal(workDir, {}) }, /没有文件/],
      ['symbolic link', async (workDir) => {
        await writeProposal(workDir, {})
        await symlink('/etc/passwd', join(workDir, 'skill-proposal', 'files', 'SKILL.md'))
      }, /不是普通文件/],
      ['hidden name', async (workDir) => { await writeProposal(workDir, { '.env': 'x' }) }, /文件名不合法/],
      ['too many files', async (workDir) => { await writeProposal(workDir, { a: '1', b: '2', c: '3', d: '4', e: '5' }) }, /文件数超过上限 4/],
      ['too large', async (workDir) => { await writeProposal(workDir, { 'SKILL.md': 'x'.repeat(5000) }) }, /超过上限 4096/],
      ['binary', async (workDir) => { await writeProposal(workDir, { 'SKILL.md': '\u0000' }) }, /NUL/],
      ['not user-invocable', async (workDir) => { await writeProposal(workDir, { 'SKILL.md': '---\nname: log-analysis\nuser-invocable: false\n---\n' }) }, /user-invocable/],
    ]
    for (const [, arrange, message] of cases) {
      const workDir = await dir()
      await arrange(workDir)
      await expect(readProposal(workDir, LIMITS)).rejects.toThrow(message)
    }
    const invalid = await dir()
    await writeProposal(invalid, {})
    await writeFile(join(invalid, 'skill-proposal', 'files', 'SKILL.md'), Buffer.from([0xff, 0xfe]))
    await expect(readProposal(invalid, LIMITS)).rejects.toThrow(/不是 UTF-8/)
  })
})

/**
 * A real `dshRepos` service for mirrors whose commit, branch, and merge
 * request calls are replaced by stand-ins that record calls and track which
 * branches exist.
 */
function fakeRepos(root: string) {
  const state = { branches: new Set<string>(), changeError: undefined as Error | undefined }
  const conflict = (branch: string) => Object.assign(new Error(`分支 ${branch} 已存在`), { name: 'RepoError', code: 'conflict' })
  const service = Object.assign(Object.create(createRepos(root)) as ReturnType<typeof createRepos>, {
    getBranch: vi.fn(async (_repo: string, name: string) => state.branches.has(name) ? { name, commit: 'f'.repeat(40), protected: false, default: false } : undefined),
    commitFiles: vi.fn(async (_repo: string, request: Record<string, unknown> & { branch: string }) => {
      if (state.branches.has(request.branch)) throw conflict(request.branch)
      state.branches.add(request.branch)
      return { sha: 'c'.repeat(40), branch: request.branch, createdBranch: true }
    }),
    createChange: vi.fn(async () => {
      if (state.changeError !== undefined) throw state.changeError
      return { number: 7, webUrl: MR_URL }
    }),
  })
  return { state, service }
}

interface Setup {
  origin: string
  registry: RepoRegistry
  task: DispatchedTask
  updater: SkillUpdater
  settings: EditableSettings
  agent: Agent
  approval: { requests: ApprovalRequest[]; request: Mock<HostApproval['request']> }
  answer: { value: ApprovalOutcome }
  repos: ReturnType<typeof fakeRepos>
}

async function setup(): Promise<Setup> {
  const root = await dir()
  const origin = await createAppRepo(join(root, 'order-service'))
  const settings: EditableSettings = {
    ...defaultsOf(resolveConfig({})),
    repos: [{ url: origin }],
    skillUpdates: { enabled: true, maxFiles: 4, maxFileBytes: 65536 },
  }
  const repos = fakeRepos(join(root, 'dsh-repo'))
  const registry = new RepoRegistry({ repos: () => repos.service, onChange: () => {} })
  registry.configure(settings.repos)
  await registry.syncAll()
  const [ready] = registry.readyApps()
  const answer: Setup['answer'] = { value: 'allowed-once' }
  const requests: ApprovalRequest[] = []
  const approval = { requests, request: vi.fn(async (req: ApprovalRequest) => { requests.push(req); return answer.value }) }
  const updater = new SkillUpdater({
    registry,
    settings: () => settings,
    author: { name: '观象', email: 'guanxiang@example.com' },
    approval: () => approval,
    repos: () => repos.service,
  })
  const workDir = join(root, 'project', '.guanxiang', 'runs', 'r1', '1-order-service')
  await mkdir(workDir, { recursive: true })
  const task: DispatchedTask = { workDir, sessionId: 'parent', app: ready!.app, url: origin, commit: ready!.commit }
  const agent: Agent = { id: 'parent', session: { header: { id: 'parent', cwd: join(root, 'project') } } }
  return { origin, registry, task, updater, settings, agent, approval, answer, repos }
}

describe('guanxiang_propose_skill', () => {
  it('checks a proposal against the analyzed commit and writes its diff', async () => {
    const { origin, task, updater } = await setup()
    expect(await updater.inspect(task)).toBeUndefined()
    const skill = await readFile(join(origin, SKILL), 'utf8')
    await writeProposal(task.workDir, { 'SKILL.md': `${skill}\n## 5. traceId\n\n日志第四列是 traceId。\n` })
    const check = await updater.inspect(task)
    expect(check).toEqual({ ok: true, files: [{ path: SKILL, added: 4, removed: 0 }], diffPath: join(task.workDir, DIFF_FILE) })
    expect(await readFile(join(task.workDir, DIFF_FILE), 'utf8')).toContain('+日志第四列是 traceId。')

    await writeProposal(task.workDir, { 'SKILL.md': skill })
    expect(await updater.inspect(task)).toEqual({ ok: false, error: expect.stringContaining('没有改动') })
  })

  it('replaces a symbolic link left at the diff path instead of writing through it', async () => {
    const { origin, task, updater } = await setup()
    const victim = join(origin, SKILL)
    const before = await readFile(victim, 'utf8')
    await symlink(victim, join(task.workDir, DIFF_FILE))
    await writeProposal(task.workDir, { 'SKILL.md': '# 新版\n' })
    expect(await updater.inspect(task)).toMatchObject({ ok: true })
    expect(await readFile(victim, 'utf8')).toBe(before)
    expect((await lstat(join(task.workDir, DIFF_FILE))).isFile()).toBe(true)
    expect(await readFile(join(task.workDir, DIFF_FILE), 'utf8')).toContain('+# 新版')
  })

  it('commits the changed files to a new branch at the analyzed commit and opens a merge request only after the user allows it', async () => {
    const { origin, task, updater, agent, approval, answer, repos } = await setup()
    const skill = await readFile(join(origin, SKILL), 'utf8')
    await writeProposal(task.workDir, { 'SKILL.md': skill, 'references/formats.md': '第四列是 traceId\n' })
    await updater.inspect(task)
    const exec = { signal: new AbortController().signal, agent, callId: 'call-1' }
    const args = { workDir: task.workDir, summary: '补充 traceId 字段说明' }

    answer.value = 'rejected'
    const rejected = await updater.execute(args, exec)
    expect(rejected.status).toBe('rejected')
    expect(rejected.branch).toMatch(/^guanxiang\/skill-order-service-[0-9a-f]{10}$/)
    expect(repos.service.commitFiles).not.toHaveBeenCalled()
    const [request] = approval.requests
    expect(request).toMatchObject({ agent, toolName: 'guanxiang_propose_skill', callId: 'call-1', signal: exec.signal })
    expect(request?.displayReason?.zh).toContain(`提交新分支 ${rejected.branch}，并创建合并请求合入 main`)
    expect(request?.displayReason?.zh).toContain('.dsh/skills/log-analysis/references/formats.md（+1 −0）')
    expect(request?.displayReason?.zh).toContain('理由：日志格式里漏了 traceId 字段')

    answer.value = 'allowed-once'
    const opened = await updater.execute(args, exec)
    expect(opened).toMatchObject({ status: 'opened', mergeRequestUrl: MR_URL, branch: rejected.branch, target: 'main', repo: origin })
    const [repo, commit] = repos.service.commitFiles.mock.calls[0]!
    expect(repo).toBe(origin)
    expect(commit).toMatchObject({
      branch: opened.branch,
      baseSha: task.commit,
      newBranch: true,
      author: { name: '观象', email: 'guanxiang@example.com' },
      files: [{ action: 'write', path: '.dsh/skills/log-analysis/references/formats.md', content: '第四列是 traceId\n' }],
      signal: exec.signal,
    })
    expect(commit.message).toMatch(new RegExp(`^补充 traceId 字段说明\\n\\n日志格式里漏了 traceId 字段\\n\\nProposed-by: 观象 GuanXiang\\nAnalyzed-commit: ${task.commit}\\nSession: parent\\n$`))
    expect(repos.service.createChange).toHaveBeenCalledWith(origin, {
      title: '补充 traceId 字段说明',
      body: expect.stringMatching(/^由观象在日志分析中提出（应用 order-service，分析提交 [0-9a-f]{12}，会话 parent）。理由：日志格式里漏了 traceId 字段$/),
      sourceBranch: opened.branch,
      targetBranch: 'main',
      signal: exec.signal,
    })
    expect(renderProposeValue(opened)[0]?.text).toContain(MR_URL)

    // The same change again finds the branch and does not ask.
    const again = await updater.execute(args, exec)
    expect(again.status).toBe('exists')
    expect(approval.request).toHaveBeenCalledTimes(2)
  })

  it('reports a committed branch whose merge request could not be created', async () => {
    const { task, updater, agent, repos } = await setup()
    await writeProposal(task.workDir, { 'SKILL.md': NEW_SKILL })
    await updater.inspect(task)
    repos.state.changeError = Object.assign(new Error('令牌没有权限'), { name: 'RepoError', code: 'forbidden' })
    const value = await updater.execute({ workDir: task.workDir, summary: '改写' }, { signal: new AbortController().signal, agent })
    expect(value).toMatchObject({ status: 'pushed', mergeRequestError: '令牌没有权限' })
    expect(value.mergeRequestUrl).toBeUndefined()
    expect(renderProposeValue(value)[0]?.text).toContain('创建合并请求失败（令牌没有权限）')
  })

  it('refuses tasks it did not dispatch for this session, and commits nothing without an approval or dshRepos service', async () => {
    const { registry, task, updater, agent, settings, repos } = await setup()
    await writeProposal(task.workDir, { 'SKILL.md': '# 新版\n' })
    const exec = { signal: new AbortController().signal, agent }
    const args = { workDir: task.workDir, summary: '改写' }
    await expect(updater.execute(args, exec)).rejects.toThrow('不是本次 DSH 运行中观象派发任务的运行目录')
    await updater.inspect(task)
    await expect(updater.execute(args, { ...exec, agent: { id: 'other', session: { header: { id: 'other' } } } })).rejects.toThrow('不是当前会话派发的任务')
    await expect(updater.execute(args, { ...exec, agent: { id: 'child', session: { header: { id: 'parent', delegationDepth: 1 } } } })).rejects.toThrow('不能在子 Agent 中调用')
    await expect(updater.execute({ ...args, summary: 'a\nb' }, exec)).rejects.toThrow('summary 只能是一行')
    settings.skillUpdates = { ...settings.skillUpdates, enabled: false }
    await expect(updater.execute(args, exec)).rejects.toThrow('未开启')
    settings.skillUpdates = { ...settings.skillUpdates, enabled: true }

    const deps = { registry, settings: () => settings }
    const withoutApproval = new SkillUpdater({ ...deps, approval: () => undefined, repos: () => repos.service })
    await withoutApproval.inspect(task)
    await expect(withoutApproval.execute(args, exec)).rejects.toThrow('没有审批服务')
    const approval = { request: vi.fn(async () => 'allowed-once' as const) }
    const withoutRepos = new SkillUpdater({ ...deps, approval: () => approval, repos: () => undefined })
    await withoutRepos.inspect(task)
    await expect(withoutRepos.execute(args, exec)).rejects.toThrow('需要 dsh-repo 插件提供的 dshRepos 服务')
    const olderRepos = new SkillUpdater({ ...deps, approval: () => approval, repos: () => ({ ...repos.service, getBranch: undefined }) })
    await olderRepos.inspect(task)
    await expect(olderRepos.execute(args, exec)).rejects.toThrow('服务与观象不兼容')
    expect(approval.request).not.toHaveBeenCalled()
    expect(repos.service.commitFiles).not.toHaveBeenCalled()
  })

  it('never commits onto a branch that appeared while the user was deciding', async () => {
    const { task, updater, agent, approval, repos } = await setup()
    await writeProposal(task.workDir, { 'SKILL.md': '# 新版\n' })
    await updater.inspect(task)
    approval.request.mockImplementationOnce(async (req: ApprovalRequest) => {
      repos.state.branches.add(/提交新分支 (\S+)，/.exec(req.reason ?? '')?.[1] as string)
      return 'allowed-once'
    })
    const value = await updater.execute({ workDir: task.workDir, summary: '改写' }, { signal: new AbortController().signal, agent })
    expect(value.status).toBe('exists')
    expect(repos.service.createChange).not.toHaveBeenCalled()
  })

  it('stops when the approval request is withdrawn by cancellation', async () => {
    const { task, updater, agent, answer, repos } = await setup()
    await writeProposal(task.workDir, { 'SKILL.md': '# 新版\n' })
    await updater.inspect(task)
    const controller = new AbortController()
    controller.abort(new Error('turn cancelled'))
    answer.value = 'cancelled'
    await expect(updater.execute({ workDir: task.workDir, summary: '改写' }, { signal: controller.signal, agent })).rejects.toThrow('turn cancelled')
    answer.value = 'unavailable'
    expect((await updater.execute({ workDir: task.workDir, summary: '改写' }, { signal: new AbortController().signal, agent })).status).toBe('unavailable')
    expect(repos.service.commitFiles).not.toHaveBeenCalled()
  })
})
