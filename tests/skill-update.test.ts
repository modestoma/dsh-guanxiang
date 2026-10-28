import { chmod, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultsOf, resolveConfig } from '../src/config.ts'
import type { Agent, ApprovalOutcome, ApprovalRequest, HostApproval } from '../src/host.ts'
import { runGit } from '../src/repos/git.ts'
import { RepoRegistry } from '../src/repos/registry.ts'
import type { EditableSettings } from '../src/settings/contract.ts'
import { DIFF_FILE, readProposal } from '../src/skill-update/proposal.ts'
import { renderProposeValue, SkillUpdater } from '../src/skill-update/tool.ts'
import type { DispatchedTask } from '../src/skill-update/tool.ts'
import { createAppRepo, git, tempDir } from './helpers.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

const LIMITS = { maxFiles: 4, maxFileBytes: 4096 }
const SKILL = '.dsh/skills/log-analysis/SKILL.md'
const MR_URL = 'https://gitlab.example.com/group/order-service/-/merge_requests/7'

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

/** An application repository whose pre-receive hook records push options and prints a merge request URL. */
async function gitlabLikeOrigin(root: string): Promise<string> {
  const origin = await createAppRepo(join(root, 'order-service'))
  git(origin, 'config', 'receive.advertisePushOptions', 'true')
  const hook = join(origin, '.git', 'hooks', 'pre-receive')
  await writeFile(hook, `#!/bin/sh
i=0
while [ "$i" -lt "\${GIT_PUSH_OPTION_COUNT:-0}" ]; do
  eval "printf '%s\\\\n' \\"\\$GIT_PUSH_OPTION_$i\\"" >> "$GIT_DIR/push-options.log"
  i=$((i + 1))
done
echo "View merge request for the branch:"
echo "  ${MR_URL}"
`)
  await chmod(hook, 0o755)
  return origin
}

interface Setup {
  origin: string
  registry: RepoRegistry
  task: DispatchedTask
  updater: SkillUpdater
  settings: EditableSettings
  agent: Agent
  approval: HostApproval & { requests: ApprovalRequest[] }
  answer: { value: ApprovalOutcome }
}

async function setup(): Promise<Setup> {
  const root = await dir()
  const origin = await gitlabLikeOrigin(root)
  const settings: EditableSettings = {
    ...defaultsOf(resolveConfig({}), { DSH_HOME: root }),
    repos: [{ url: origin }],
    skillUpdates: { enabled: true, maxFiles: 4, maxFileBytes: 65536 },
  }
  const registry = new RepoRegistry({ git: runGit, gitTimeoutMs: 30_000, onChange: () => {} })
  registry.configure(settings.reposDir, settings.repos)
  await registry.syncAll()
  const [ready] = registry.readyApps()
  const answer: Setup['answer'] = { value: 'allowed-once' }
  const requests: ApprovalRequest[] = []
  const approval = { requests, request: vi.fn(async (req: ApprovalRequest) => { requests.push(req); return answer.value }) }
  const updater = new SkillUpdater({
    registry,
    settings: () => settings,
    git: runGit,
    gitTimeoutMs: 30_000,
    author: { name: '观象', email: 'guanxiang@example.com' },
    approval: () => approval,
  })
  const workDir = join(root, 'project', '.guanxiang', 'runs', 'r1', '1-order-service')
  await mkdir(workDir, { recursive: true })
  const task: DispatchedTask = { workDir, sessionId: 'parent', app: ready!.app, url: origin, commit: ready!.commit }
  const agent: Agent = { id: 'parent', session: { header: { id: 'parent', cwd: join(root, 'project') } } }
  return { origin, registry, task, updater, settings, agent, approval, answer }
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

  it('pushes a new branch and opens a merge request only after the user allows it', async () => {
    const { origin, task, updater, agent, approval, answer } = await setup()
    await writeProposal(task.workDir, { 'SKILL.md': '---\nname: log-analysis\ndescription: 新版\n---\n\n# 新版\n' })
    await updater.inspect(task)
    const exec = { signal: new AbortController().signal, agent, callId: 'call-1' }
    const args = { workDir: task.workDir, summary: '补充 traceId 字段说明' }

    answer.value = 'rejected'
    const rejected = await updater.execute(args, exec)
    expect(rejected.status).toBe('rejected')
    expect(rejected.branch).toMatch(/^guanxiang\/skill-order-service-[0-9a-f]{10}$/)
    expect(git(origin, 'branch', '--list', 'guanxiang/*').trim()).toBe('')
    const [request] = approval.requests
    expect(request).toMatchObject({ agent, toolName: 'guanxiang_propose_skill', callId: 'call-1', signal: exec.signal })
    expect(request?.displayReason?.zh).toContain(`推送新分支 ${rejected.branch}，并创建合并请求合入 main`)
    expect(request?.displayReason?.zh).toContain(`${SKILL}（+`)
    expect(request?.displayReason?.zh).toContain('理由：日志格式里漏了 traceId 字段')

    answer.value = 'allowed-once'
    const opened = await updater.execute(args, exec)
    expect(opened).toMatchObject({ status: 'opened', mergeRequestUrl: MR_URL, branch: rejected.branch, target: 'main', repo: origin })
    expect(git(origin, 'show', `${opened.branch}:${SKILL}`)).toBe('---\nname: log-analysis\ndescription: 新版\n---\n\n# 新版\n')
    expect(git(origin, 'rev-parse', `${opened.branch}^`).trim()).toBe(task.commit)
    expect(git(origin, 'log', '-1', '--format=%an <%ae>%n%s', opened.branch).trim()).toBe('观象 <guanxiang@example.com>\n补充 traceId 字段说明')
    expect(git(origin, 'diff', '--name-only', task.commit, opened.branch).trim()).toBe(SKILL)
    const options = (await readFile(join(origin, '.git', 'push-options.log'), 'utf8')).trim().split('\n')
    expect(options.slice(0, 3)).toEqual(['merge_request.create', 'merge_request.target=main', 'merge_request.title=补充 traceId 字段说明'])
    expect(options[3]).toMatch(/^merge_request\.description=由观象在日志分析中提出（应用 order-service，分析提交 [0-9a-f]{12}，会话 parent）。理由：日志格式里漏了 traceId 字段$/)
    expect(renderProposeValue(opened)[0]?.text).toContain(MR_URL)

    // The same change again finds the branch and does not ask.
    const again = await updater.execute(args, exec)
    expect(again.status).toBe('exists')
    expect(approval.request).toHaveBeenCalledTimes(2)
  })

  it('refuses tasks it did not dispatch for this session, and pushes nothing without an approval service', async () => {
    const { registry, task, updater, agent, settings } = await setup()
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

    const withoutApproval = new SkillUpdater({ registry, settings: () => settings, git: runGit, gitTimeoutMs: 30_000, approval: () => undefined })
    await withoutApproval.inspect(task)
    await expect(withoutApproval.execute(args, exec)).rejects.toThrow('没有审批服务')
  })

  it('stops when the approval request is withdrawn by cancellation', async () => {
    const { task, updater, agent, answer, origin } = await setup()
    await writeProposal(task.workDir, { 'SKILL.md': '# 新版\n' })
    await updater.inspect(task)
    const controller = new AbortController()
    controller.abort(new Error('turn cancelled'))
    answer.value = 'cancelled'
    await expect(updater.execute({ workDir: task.workDir, summary: '改写' }, { signal: controller.signal, agent })).rejects.toThrow('turn cancelled')
    answer.value = 'unavailable'
    expect((await updater.execute({ workDir: task.workDir, summary: '改写' }, { signal: new AbortController().signal, agent })).status).toBe('unavailable')
    expect(git(origin, 'branch', '--list', 'guanxiang/*').trim()).toBe('')
  })
})
