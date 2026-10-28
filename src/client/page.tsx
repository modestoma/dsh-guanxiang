/**
 * 左侧栏「观象」主区页面：应用仓库、访问令牌、日志下载、分析接口、高级（含 SKILL 改进）五个
 * 分页，共用一份草稿和底部保存条；令牌值不进草稿，单独存入 DSH 凭据库。
 * 仓库拉取中时每 2 秒刷新状态。
 *
 * @module dsh-guanxiang/client/page
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AnalyzeWire, EditableKey, EditableSettings, GitCredentialSpec, RepoSpec, RepoStatusWire, StateWire, TokenStatusWire } from '../settings/contract.ts'
import { clearToken, fetchState, messageOf, resetSettings, saveSettings, saveToken, syncRepos } from './api.ts'

/** Sidebar label and page title. */
export const PANEL_TITLE = '观象'

const KB = 1024
const MB = 1024 * 1024
const MINUTE = 60 * 1000

type TabId = 'repos' | 'tokens' | 'download' | 'analyze' | 'advanced'

const TABS: readonly { id: TabId; label: string }[] = [
  { id: 'repos', label: '应用仓库' },
  { id: 'tokens', label: '访问令牌' },
  { id: 'download', label: '日志下载' },
  { id: 'analyze', label: '分析接口' },
  { id: 'advanced', label: '高级' },
]

/** Editable text form of the settings. */
interface Draft {
  reposDir: string
  repos: RepoSpec[]
  gitCredentials: GitCredentialSpec[]
  fetchIntervalMin: string
  maxAppsPerRequest: string
  dispatchTimeoutMin: string
  allowedHosts: string[]
  maxMb: string
  timeoutSec: string
  skillUpdatesEnabled: boolean
  skillMaxFiles: string
  skillMaxKb: string
  analyzeEnabled: boolean
}

function trimNumber(value: number): string {
  return String(Math.round(value * 100) / 100)
}

function toDraft(settings: EditableSettings): Draft {
  return {
    reposDir: settings.reposDir,
    repos: settings.repos.map(repo => ({ ...repo })),
    gitCredentials: settings.gitCredentials.map(credential => ({ ...credential })),
    fetchIntervalMin: trimNumber(settings.fetchIntervalMs / MINUTE),
    maxAppsPerRequest: String(settings.maxAppsPerRequest),
    dispatchTimeoutMin: trimNumber(settings.dispatchTimeoutMs / MINUTE),
    allowedHosts: [...settings.download.allowedHosts],
    maxMb: trimNumber(settings.download.maxBytes / MB),
    timeoutSec: trimNumber(settings.download.timeoutMs / 1000),
    skillUpdatesEnabled: settings.skillUpdates.enabled,
    skillMaxFiles: String(settings.skillUpdates.maxFiles),
    skillMaxKb: trimNumber(settings.skillUpdates.maxFileBytes / KB),
    analyzeEnabled: settings.analyze.enabled,
  }
}

function positive(text: string, label: string, allowZero = false): number {
  const value = Number(text.trim())
  if (text.trim() === '' || !Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) throw new Error(`${label}必须是${allowZero ? '非负' : '正'}数`)
  return value
}

function fromDraft(draft: Draft): EditableSettings {
  const maxApps = positive(draft.maxAppsPerRequest, '单次应用数上限')
  if (!Number.isInteger(maxApps)) throw new Error('单次应用数上限必须是整数')
  const maxFiles = positive(draft.skillMaxFiles, '提议文件数上限')
  if (!Number.isInteger(maxFiles)) throw new Error('提议文件数上限必须是整数')
  return {
    reposDir: draft.reposDir.trim(),
    repos: draft.repos.map(repo => repo.branch === undefined || repo.branch.trim() === '' ? { url: repo.url.trim() } : { url: repo.url.trim(), branch: repo.branch.trim() }),
    gitCredentials: draft.gitCredentials.map(credential => ({
      url: credential.url.trim(),
      ...credential.alias === undefined || credential.alias.trim() === '' ? {} : { alias: credential.alias.trim() },
      username: credential.username.trim(),
      tokenEnv: credential.tokenEnv.trim(),
    })),
    fetchIntervalMs: Math.round(positive(draft.fetchIntervalMin, '更新间隔', true) * MINUTE),
    maxAppsPerRequest: maxApps,
    dispatchTimeoutMs: Math.round(positive(draft.dispatchTimeoutMin, '派发超时') * MINUTE),
    download: {
      allowedHosts: draft.allowedHosts.map(host => host.trim()).filter(host => host !== ''),
      maxBytes: Math.round(positive(draft.maxMb, '单文件大小上限') * MB),
      timeoutMs: Math.round(positive(draft.timeoutSec, '下载超时') * 1000),
    },
    skillUpdates: {
      enabled: draft.skillUpdatesEnabled,
      maxFiles,
      maxFileBytes: Math.round(positive(draft.skillMaxKb, '提议单文件大小上限') * KB),
    },
    analyze: { enabled: draft.analyzeEnabled },
  }
}

function sameSettings(draft: Draft, settings: EditableSettings): boolean {
  try {
    return JSON.stringify(fromDraft(draft)) === JSON.stringify(settings)
  } catch {
    // An unparsable draft differs from any saved settings.
    return false
  }
}

function formatTime(iso: string | number | undefined): string {
  if (iso === undefined) return ''
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString()
}

function phasePill(repo: RepoStatusWire | undefined): JSX.Element {
  if (repo === undefined) return <span className="gx__pill"><span className="gx__dot" />保存后拉取</span>
  if (repo.phase === 'syncing') return <span className="gx__pill gx__pill--warn"><span className="gx__dot" />拉取中</span>
  if (repo.available) return <span className="gx__pill gx__pill--ok"><span className="gx__dot" />就绪</span>
  if (repo.phase === 'ready' || repo.phase === 'failed') return <span className="gx__pill gx__pill--bad"><span className="gx__dot" />不可用</span>
  return <span className="gx__pill"><span className="gx__dot" />待拉取</span>
}

function Overridden({ keys, name }: { keys: readonly EditableKey[]; name: EditableKey }): JSX.Element | null {
  return keys.includes(name) ? <span className="gx__tag gx__tag--accent">面板设置</span> : null
}

/**
 * Main-column page for the `main` slot.
 * @returns the page.
 */
export function GuanxiangPage(): JSX.Element {
  return (
    <section className="gx-page" aria-label={PANEL_TITLE}>
      <div className="gx-page__content">
        <GuanxiangPanel />
      </div>
    </section>
  )
}

type Notice = { kind: 'ok' | 'error'; text: string } | undefined

/**
 * Panel body: loads state, edits a draft, saves.
 * @returns the panel.
 */
export function GuanxiangPanel(): JSX.Element {
  const [state, setState] = useState<StateWire | undefined>()
  const [loadError, setLoadError] = useState<string | undefined>()
  const [draft, setDraft] = useState<Draft | undefined>()
  const [tab, setTab] = useState<TabId>('repos')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>()

  const adopt = useCallback((next: StateWire, resetDraft: boolean) => {
    setState(next)
    if (resetDraft) setDraft(toDraft(next.settings))
  }, [])

  const reload = useCallback(async (resetDraft: boolean) => {
    try {
      adopt(await fetchState(), resetDraft)
      setLoadError(undefined)
    } catch (error) {
      setLoadError(messageOf(error))
    }
  }, [adopt])

  useEffect(() => { void reload(true) }, [reload])

  const syncing = state?.repos.some(repo => repo.phase === 'syncing') === true
  useEffect(() => {
    if (!syncing) return
    const timer = setInterval(() => { void reload(false) }, 2000)
    return () => { clearInterval(timer) }
  }, [syncing, reload])

  const dirty = state !== undefined && draft !== undefined && !sameSettings(draft, state.settings)

  const run = async (action: () => Promise<StateWire>, success: string, resetDraft: boolean): Promise<StateWire | undefined> => {
    setBusy(true)
    setNotice(undefined)
    try {
      const next = await action()
      adopt(next, resetDraft)
      setNotice({ kind: 'ok', text: success })
      return next
    } catch (error) {
      setNotice({ kind: 'error', text: messageOf(error) })
      return undefined
    } finally {
      setBusy(false)
    }
  }

  const save = (): void => {
    if (draft === undefined) return
    let settings: EditableSettings
    try {
      settings = fromDraft(draft)
    } catch (error) {
      setNotice({ kind: 'error', text: messageOf(error) })
      return
    }
    void run(() => saveSettings(settings), '已保存，新的仓库会在后台拉取', true)
  }

  if (state === undefined || draft === undefined) {
    return (
      <div className="gx">
        {loadError === undefined
          ? <div className="gx__loading">加载中…</div>
          : <div className="gx__notice gx__notice--error">{loadError} <button type="button" className="gx__btn gx__btn--ghost" onClick={() => { void reload(true) }}>重试</button></div>}
      </div>
    )
  }

  const available = state.repos.filter(repo => repo.available).length
  return (
    <div className="gx">
      <header className="gx__head">
        <div className="gx__headRow">
          <h1 className="gx__title">{PANEL_TITLE}</h1>
          <span className={`gx__pill ${available > 0 ? 'gx__pill--ok' : 'gx__pill--warn'}`}><span className="gx__dot" />{available} 个应用可用</span>
          {syncing ? <span className="gx__pill gx__pill--warn"><span className="gx__dot" />拉取中</span> : null}
        </div>
        <div className="gx__meta">观其象，知其因。在对话中输入 /guanxiang 描述问题并附上日志，观象会按应用派发分析。</div>
        <div className="gx__tabs" role="tablist">
          {TABS.map(item => (
            <button key={item.id} type="button" role="tab" className="gx__tab" aria-selected={tab === item.id} onClick={() => { setTab(item.id) }}>{item.label}</button>
          ))}
        </div>
      </header>
      {state.overlayError === undefined ? null : <div className="gx__notice gx__notice--error">面板设置文件未生效：{state.overlayError}。保存一次会用当前内容覆盖它。</div>}
      <div className="gx__body" role="tabpanel">
        {tab === 'repos' ? <ReposTab draft={draft} setDraft={setDraft} state={state} busy={busy || dirty} onSync={(url) => { void run(() => syncRepos(url), url === undefined ? '已开始重新拉取全部仓库' : '已开始重新拉取', false) }} /> : null}
        {tab === 'tokens'
          ? <TokensTab
              draft={draft}
              setDraft={setDraft}
              state={state}
              busy={busy}
              onAdd={async (credential, token) => {
                const saved = await run(() => saveSettings({ ...state.settings, gitCredentials: [...state.settings.gitCredentials, credential] }), token === '' ? `已添加 ${credential.url}，请填入令牌` : `已添加 ${credential.url}`, false)
                const added = saved?.settings.gitCredentials[state.settings.gitCredentials.length]
                if (added === undefined) return false
                setDraft(current => current === undefined || current.gitCredentials.some(item => item.url === added.url) ? current : { ...current, gitCredentials: [...current.gitCredentials, added] })
                return token === '' || await run(() => saveToken(added.tokenEnv, token), `已添加 ${added.url} 并保存令牌，使用它的仓库会重新拉取`, false) !== undefined
              }}
              onSave={async (tokenEnv, value) => await run(() => saveToken(tokenEnv, value), `已保存 ${tokenEnv}，使用它的仓库会重新拉取`, false) !== undefined}
              onClear={(tokenEnv) => { void run(() => clearToken(tokenEnv), `已清除面板保存的 ${tokenEnv}`, false) }}
            />
          : null}
        {tab === 'download' ? <DownloadTab draft={draft} setDraft={setDraft} overridden={state.overridden} /> : null}
        {tab === 'analyze'
          ? <AnalyzeTab
              draft={draft}
              setDraft={setDraft}
              analyze={state.analyze}
              credentialsAvailable={state.credentials.available}
              overridden={state.overridden}
              busy={busy}
              onSave={async value => await run(() => saveToken(state.analyze.tokenEnv, value), '已保存分析接口令牌，下一个请求起生效', false) !== undefined}
              onClear={() => { void run(() => clearToken(state.analyze.tokenEnv), '已清除面板保存的分析接口令牌', false) }}
            />
          : null}
        {tab === 'advanced' ? <AdvancedTab draft={draft} setDraft={setDraft} overridden={state.overridden} busy={busy} onReset={() => { void run(resetSettings, '已恢复为 cordis.yml 中的配置', true) }} /> : null}
      </div>
      {notice === undefined ? null : <div className={`gx__notice gx__notice--${notice.kind}`}>{notice.text}</div>}
      <div className="gx__saveBar">
        <span className="gx__saveMsg">{dirty ? '有未保存的修改' : '设置已保存'}</span>
        <button type="button" className="gx__btn gx__btn--ghost" disabled={!dirty || busy} onClick={() => { setDraft(toDraft(state.settings)); setNotice(undefined) }}>放弃修改</button>
        <button type="button" className="gx__btn gx__btn--primary" disabled={!dirty || busy} onClick={save}>保存</button>
      </div>
    </div>
  )
}

interface TabProps {
  draft: Draft
  setDraft: (next: Draft) => void
}

function ReposTab({ draft, setDraft, state, busy, onSync }: TabProps & { state: StateWire; busy: boolean; onSync: (url?: string) => void }): JSX.Element {
  const [url, setUrl] = useState('')
  const [branch, setBranch] = useState('')
  const status = useMemo(() => new Map(state.repos.map(repo => [repo.url, repo])), [state.repos])
  const add = (): void => {
    const trimmed = url.trim()
    if (trimmed === '' || draft.repos.some(repo => repo.url === trimmed)) return
    setDraft({ ...draft, repos: [...draft.repos, branch.trim() === '' ? { url: trimmed } : { url: trimmed, branch: branch.trim() }] })
    setUrl('')
    setBranch('')
  }
  return (
    <section className="gx__sec">
      <h2 className="gx__secTitle">应用仓库 <Overridden keys={state.overridden} name="repos" /></h2>
      <div className="gx__list">
        {draft.repos.length === 0 ? <div className="gx__emptyRow">还没有应用仓库。添加 git 地址后保存，观象会把仓库拉取到本机。</div> : null}
        {draft.repos.map((repo, index) => {
          const current = status.get(repo.url)
          const saved = current !== undefined && current.branch === repo.branch
          return (
            <div key={repo.url} className="gx__row gx__row--top">
              <div className="gx__rowText">
                <div className="gx__rowLabel">
                  <span className="gx__mono">{repo.url}</span>
                  {repo.branch === undefined ? null : <span className="gx__tag">{repo.branch}</span>}
                  {phasePill(saved ? current : undefined)}
                </div>
                {saved && current.app !== undefined
                  ? <div className="gx__rowSummary">{current.app.name}（<span className="gx__mono">{current.app.id}</span>）· SKILL <span className="gx__mono">/{current.app.skill}</span>{current.activeRuns > 0 ? ` · ${current.activeRuns} 个分析进行中` : ''}</div>
                  : null}
                {saved && current.app !== undefined ? <div className="gx__rowSummary">{current.app.description}</div> : null}
                {saved && current.commit !== undefined
                  ? <div className="gx__rowSummary">提交 <span className="gx__mono">{current.commit.slice(0, 8)}</span>（{formatTime(current.commitTime)}）· 拉取于 {formatTime(current.syncedAt)} · <span className="gx__mono">{current.dir}</span></div>
                  : null}
                {saved && current.error !== undefined ? <div className="gx__rowError">{current.error}</div> : null}
              </div>
              <div className="gx__rowCtl">
                {saved ? <button type="button" className="gx__btn" disabled={busy || current.phase === 'syncing'} onClick={() => { onSync(repo.url) }}>重新拉取</button> : null}
                <button type="button" className="gx__btn gx__btn--danger" onClick={() => { setDraft({ ...draft, repos: draft.repos.filter((_, position) => position !== index) }) }}>删除</button>
              </div>
            </div>
          )
        })}
        <div className="gx__addRow">
          <input className="gx__input" placeholder="git 地址，例如 git@github.com:example/order-service.git" value={url} onChange={(event) => { setUrl(event.target.value) }} onKeyDown={(event) => { if (event.key === 'Enter') add() }} />
          <input className="gx__input gx__input--branch" placeholder="分支（可选）" value={branch} onChange={(event) => { setBranch(event.target.value) }} onKeyDown={(event) => { if (event.key === 'Enter') add() }} />
          <button type="button" className="gx__btn" disabled={url.trim() === ''} onClick={add}>添加</button>
        </div>
      </div>
      <p className="gx__secFoot">使用本机已有的 git 凭据（SSH key 或 credential helper）拉取；https 地址可在「访问令牌」中配置个人访问令牌。不留分支时跟随远端默认分支。每个仓库需包含 <span className="gx__mono">.dsh/guanxiang.yaml</span> 与其中声明的日志分析 SKILL。删除地址不会删除本地目录。</p>
      {state.repos.length > 0 ? <div><button type="button" className="gx__btn" disabled={busy} onClick={() => { onSync() }}>重新拉取全部</button></div> : null}
    </section>
  )
}

const DEFAULT_USERNAME = 'oauth2'
/** Prefix of the credential keys the panel allocates; namespaced so an unrelated `GITLAB_TOKEN` in the environment is not picked up. */
const DEFAULT_TOKEN_ENV = 'GUANXIANG_GITLAB_TOKEN'

/** Credential store layers of `@deepseek-ai/dsh-credentials-local` other than its own file. */
const TOKEN_SOURCES: Readonly<Record<string, string>> = { 'env': '启动环境变量', 'project-env': '项目 .env', 'user-env': '$DSH_HOME/.env' }

function tokenPill(token: TokenStatusWire | undefined): JSX.Element {
  if (token === undefined) return <span className="gx__pill"><span className="gx__dot" />保存后设置令牌</span>
  if (token.error !== undefined) return <span className="gx__pill gx__pill--bad"><span className="gx__dot" />无法读取</span>
  if (!token.configured) return <span className="gx__pill gx__pill--warn"><span className="gx__dot" />未设置令牌</span>
  const source = token.source === undefined || token.source === 'file' ? undefined : TOKEN_SOURCES[token.source] ?? token.source
  return <span className="gx__pill gx__pill--ok"><span className="gx__dot" />已设置{source === undefined ? '' : `（来自${source}）`}</span>
}

/**
 * First of `GUANXIANG_GITLAB_TOKEN`, `GUANXIANG_GITLAB_TOKEN_2`, … that no
 * saved or drafted entry uses.
 * @param used - keys already in use.
 * @returns a free key.
 */
function freeTokenEnv(used: ReadonlySet<string>): string {
  if (!used.has(DEFAULT_TOKEN_ENV)) return DEFAULT_TOKEN_ENV
  let index = 2
  while (used.has(`${DEFAULT_TOKEN_ENV}_${index}`)) index += 1
  return `${DEFAULT_TOKEN_ENV}_${index}`
}

function TokensTab({ draft, setDraft, state, busy, onAdd, onSave, onClear }: TabProps & {
  state: StateWire
  busy: boolean
  /** Saves the entry, then its token; resolves whether both succeeded. */
  onAdd: (credential: GitCredentialSpec, token: string) => Promise<boolean>
  onSave: (tokenEnv: string, value: string) => Promise<boolean>
  onClear: (tokenEnv: string) => void
}): JSX.Element {
  const [url, setUrl] = useState('')
  const [alias, setAlias] = useState('')
  const [token, setToken] = useState('')
  const [addError, setAddError] = useState<string | undefined>()
  // Spans both requests of one addition; `busy` drops between them.
  const [adding, setAdding] = useState(false)
  const [values, setValues] = useState<Record<string, string>>({})
  const tokens = useMemo(() => new Map(state.credentials.tokens.map(item => [item.tokenEnv, item])), [state.credentials.tokens])
  const saved = useMemo(() => new Set(state.settings.gitCredentials.map(credential => credential.tokenEnv)), [state.settings.gitCredentials])
  const complete = url.trim() !== '' && alias.trim() !== '' && token.trim() !== ''
  const add = (): void => {
    if (!complete || busy || adding) return
    const address = url.trim()
    if (state.settings.gitCredentials.some(credential => credential.url === address)) {
      setAddError('这个地址已经添加过了，请在上面的列表里更新它的令牌。')
      return
    }
    setAddError(undefined)
    setAdding(true)
    const tokenEnv = freeTokenEnv(new Set([...saved, ...draft.gitCredentials.map(credential => credential.tokenEnv)]))
    void onAdd({ url: address, alias: alias.trim(), username: DEFAULT_USERNAME, tokenEnv }, token.trim()).then((ok) => {
      if (!ok) return
      setUrl('')
      setAlias('')
      setToken('')
    }).finally(() => { setAdding(false) })
  }
  const save = (name: string): void => {
    const value = values[name]?.trim() ?? ''
    if (value === '' || busy || adding) return
    void onSave(name, value).then((ok) => { if (ok) setValues(current => ({ ...current, [name]: '' })) })
  }
  const submitOnEnter = (event: { key: string }): void => { if (event.key === 'Enter') add() }
  return (
    <section className="gx__sec">
      <h2 className="gx__secTitle">GitLab 访问令牌 <Overridden keys={state.overridden} name="gitCredentials" /></h2>
      {state.credentials.available ? null : <div className="gx__notice gx__notice--error">当前 DSH 组合没有加载凭据服务（@deepseek-ai/dsh-credentials-local），无法保存或读取令牌。</div>}
      <div className="gx__list">
        {draft.gitCredentials.length === 0 ? <div className="gx__emptyRow">还没有访问令牌。用 https 地址拉取 GitLab 私有仓库时，在下面填入 GitLab 地址、令牌别名和令牌。</div> : null}
        {draft.gitCredentials.map((credential, index) => {
          const status = saved.has(credential.tokenEnv) ? tokens.get(credential.tokenEnv) : undefined
          const value = values[credential.tokenEnv] ?? ''
          return (
            <div key={credential.url} className="gx__row gx__row--top">
              <div className="gx__rowText">
                <div className="gx__rowLabel">
                  <span>{credential.alias ?? credential.url}</span>
                  {tokenPill(status)}
                </div>
                {credential.alias === undefined ? null : <div className="gx__rowSummary gx__mono">{credential.url}</div>}
                {status?.error === undefined ? null : <div className="gx__rowError">{status.error}</div>}
                {status !== undefined && status.writable
                  ? (
                      <div className="gx__addRow gx__addRow--flush">
                        <input className="gx__input gx__mono" type="password" autoComplete="new-password" spellCheck={false} placeholder={status.configured ? '输入新令牌以替换' : '粘贴令牌'} value={value} onChange={(event) => { setValues({ ...values, [credential.tokenEnv]: event.target.value }) }} onKeyDown={(event) => { if (event.key === 'Enter') save(credential.tokenEnv) }} />
                        <button type="button" className="gx__btn" disabled={busy || adding || value.trim() === ''} onClick={() => { save(credential.tokenEnv) }}>保存令牌</button>
                        {status.configured && status.source === 'file' ? <button type="button" className="gx__btn gx__btn--ghost" disabled={busy} onClick={() => { onClear(credential.tokenEnv) }}>清除</button> : null}
                      </div>
                    )
                  : null}
              </div>
              <div className="gx__rowCtl">
                <button type="button" className="gx__btn gx__btn--danger" onClick={() => { setDraft({ ...draft, gitCredentials: draft.gitCredentials.filter((_, position) => position !== index) }) }}>删除</button>
              </div>
            </div>
          )
        })}
        <div className="gx__addForm">
          <div className="gx__addRow gx__addRow--flush">
            <label className="gx__field">GitLab 地址<input className="gx__input" placeholder="https://gitlab.example.com" value={url} onChange={(event) => { setUrl(event.target.value) }} onKeyDown={submitOnEnter} /></label>
            <label className="gx__field">令牌别名<input className="gx__input" placeholder="例如 guanxiang" value={alias} onChange={(event) => { setAlias(event.target.value) }} onKeyDown={submitOnEnter} /></label>
            <label className="gx__field">令牌<input className="gx__input gx__mono" type="password" autoComplete="new-password" spellCheck={false} placeholder="粘贴个人访问令牌" value={token} onChange={(event) => { setToken(event.target.value) }} onKeyDown={submitOnEnter} /></label>
            <button type="button" className="gx__btn gx__btn--end" disabled={busy || adding || !complete} onClick={add}>添加</button>
          </div>
          {addError === undefined ? null : <div className="gx__rowError">{addError}</div>}
        </div>
      </div>
      <p className="gx__secFoot">地址在这个前缀下的 https 仓库使用对应令牌（多个匹配时取路径最长的），ssh 地址不受影响。拉取需要 read_repository 权限，开启 SKILL 改进时还需要 write_repository。令牌保存在 DSH 凭据库（默认 $DSH_HOME/.credentials.yaml，仅本机用户可读），面板只显示是否已设置；令牌只经环境变量交给 git，不写入设置文件、仓库配置、日志或模型上下文。</p>
    </section>
  )
}

function DownloadTab({ draft, setDraft, overridden }: TabProps & { overridden: readonly EditableKey[] }): JSX.Element {
  const [host, setHost] = useState('')
  const add = (): void => {
    const trimmed = host.trim().toLowerCase()
    if (trimmed === '' || draft.allowedHosts.includes(trimmed)) return
    setDraft({ ...draft, allowedHosts: [...draft.allowedHosts, trimmed] })
    setHost('')
  }
  return (
    <>
      <section className="gx__sec">
        <h2 className="gx__secTitle">允许下载的域名 <Overridden keys={overridden} name="download" /></h2>
        <div className="gx__list">
          {draft.allowedHosts.length === 0 ? <div className="gx__emptyRow">未配置域名，消息中的日志下载链接不会被下载。</div> : null}
          {draft.allowedHosts.map(item => (
            <div key={item} className="gx__row">
              <div className="gx__rowText"><span className="gx__mono">{item}</span></div>
              <div className="gx__rowCtl"><button type="button" className="gx__btn gx__btn--danger" onClick={() => { setDraft({ ...draft, allowedHosts: draft.allowedHosts.filter(entry => entry !== item) }) }}>删除</button></div>
            </div>
          ))}
          <div className="gx__addRow">
            <input className="gx__input" placeholder="主机名，例如 oss.example.com" value={host} onChange={(event) => { setHost(event.target.value) }} onKeyDown={(event) => { if (event.key === 'Enter') add() }} />
            <button type="button" className="gx__btn" disabled={host.trim() === ''} onClick={add}>添加</button>
          </div>
        </div>
        <p className="gx__secFoot">只填主机名，同时允许它的子域名。下载不携带任何鉴权信息，每次重定向都会重新校验域名。</p>
      </section>
      <section className="gx__sec">
        <h2 className="gx__secTitle">限制</h2>
        <div className="gx__list">
          <NumberRow label="单文件大小上限" unit="MB" value={draft.maxMb} onChange={(value) => { setDraft({ ...draft, maxMb: value }) }} />
          <NumberRow label="单文件下载超时" unit="秒" value={draft.timeoutSec} onChange={(value) => { setDraft({ ...draft, timeoutSec: value }) }} />
        </div>
      </section>
    </>
  )
}

const TOPICS_STATUS: Readonly<Record<AnalyzeWire['topics'], { pill: string; text: string }>> = {
  ready: { pill: 'gx__pill--ok', text: '飞书渠道就绪' },
  missing: { pill: 'gx__pill--bad', text: '未找到飞书渠道' },
  incompatible: { pill: 'gx__pill--bad', text: '飞书渠道版本不兼容' },
}

function AnalyzeTab({ draft, setDraft, analyze, credentialsAvailable, overridden, busy, onSave, onClear }: TabProps & {
  analyze: AnalyzeWire
  credentialsAvailable: boolean
  overridden: readonly EditableKey[]
  busy: boolean
  onSave: (value: string) => Promise<boolean>
  onClear: () => void
}): JSX.Element {
  const [value, setValue] = useState('')
  const token = analyze.token
  const save = (): void => {
    const trimmed = value.trim()
    if (trimmed === '' || busy) return
    void onSave(trimmed).then((ok) => { if (ok) setValue('') })
  }
  const topics = TOPICS_STATUS[analyze.topics]
  const endpoint = new URL(analyze.route.slice(1), document.baseURI).href
  return (
    <>
      <section className="gx__sec">
        <h2 className="gx__secTitle">日志平台分析接口</h2>
        <div className="gx__list">
          <div className="gx__row">
            <div className="gx__rowText">
              <div className="gx__rowLabel">开启接口 <Overridden keys={overridden} name="analyze" /><span className={`gx__pill ${topics.pill}`}><span className="gx__dot" />{topics.text}</span></div>
              <div className="gx__rowSummary">日志平台调用接口后，观象经飞书渠道（dsh-channels 0.8 及以上）在目标群发出分析卡片，并在卡片下的话题里开始分析；群内成员都可以在话题里继续追问。关闭时接口回复 404。</div>
              {analyze.topics === 'ready' ? null : <div className="gx__rowError">{analyze.topics === 'missing' ? '接口需要 dsh-channels 0.8 及以上版本并已加载；dsh-channels 0.7 自带同名接口，升级前由它提供。' : '请把观象与 dsh-channels 升级到相互兼容的版本。'}</div>}
            </div>
            <div className="gx__rowCtl"><input type="checkbox" className="gx__check" aria-label="开启分析接口" checked={draft.analyzeEnabled} onChange={(event) => { setDraft({ ...draft, analyzeEnabled: event.target.checked }) }} /></div>
          </div>
          <div className="gx__row gx__row--top">
            <div className="gx__rowText">
              <div className="gx__rowLabel">访问令牌 <span className="gx__tag gx__mono">{analyze.tokenEnv}</span>{credentialsAvailable ? tokenPill(token) : null}</div>
              <div className="gx__rowSummary">日志平台以 <span className="gx__mono">Authorization: Bearer &lt;令牌&gt;</span> 调用接口。令牌未设置时接口回复 503。</div>
              {credentialsAvailable ? null : <div className="gx__rowError">当前 DSH 组合没有加载凭据服务（@deepseek-ai/dsh-credentials-local），无法保存或读取令牌。</div>}
              {token?.error === undefined ? null : <div className="gx__rowError">{token.error}</div>}
              {token !== undefined && token.writable
                ? (
                    <div className="gx__addRow gx__addRow--flush">
                      <input className="gx__input gx__mono" type="password" autoComplete="new-password" spellCheck={false} placeholder={token.configured ? '输入新令牌以替换' : '粘贴令牌'} value={value} onChange={(event) => { setValue(event.target.value) }} onKeyDown={(event) => { if (event.key === 'Enter') save() }} />
                      <button type="button" className="gx__btn" disabled={busy || value.trim() === ''} onClick={save}>保存令牌</button>
                      {token.configured && token.source === 'file' ? <button type="button" className="gx__btn gx__btn--ghost" disabled={busy} onClick={onClear}>清除</button> : null}
                    </div>
                  )
                : null}
            </div>
          </div>
        </div>
      </section>
      <section className="gx__sec">
        <h2 className="gx__secTitle">调用方式</h2>
        <div className="gx__list">
          <div className="gx__row"><div className="gx__rowText"><div className="gx__rowLabel">地址</div><div className="gx__rowSummary gx__mono">POST {endpoint}</div></div></div>
          <div className="gx__row"><div className="gx__rowText"><div className="gx__rowLabel">请求头</div><div className="gx__rowSummary gx__mono">Authorization: Bearer &lt;令牌&gt; · Idempotency-Key: &lt;1-200 个可见 ASCII 字符&gt; · Content-Type: application/json</div></div></div>
          <div className="gx__row"><div className="gx__rowText"><div className="gx__rowLabel">请求体</div><div className="gx__rowSummary gx__mono">requesterUserId, triggeredAt, app, errorCode, logDetails[{'{'}name, url{'}'}], chatId, prompt</div></div></div>
          <div className="gx__row"><div className="gx__rowText"><div className="gx__rowLabel">响应</div><div className="gx__rowSummary">202 已发出分析卡片（同一 Idempotency-Key 重试返回同一张卡片）；400/401/404/405/409/413/415 请求问题；403 目标群未授权；502 卡片发送失败；503 飞书未连接或令牌未设置。字段说明见观象 README。</div></div></div>
        </div>
      </section>
    </>
  )
}

function AdvancedTab({ draft, setDraft, overridden, busy, onReset }: TabProps & { overridden: readonly EditableKey[]; busy: boolean; onReset: () => void }): JSX.Element {
  return (
    <>
      <section className="gx__sec">
        <h2 className="gx__secTitle">仓库</h2>
        <div className="gx__list">
          <div className="gx__row">
            <div className="gx__rowText">
              <div className="gx__rowLabel">拉取目录 <Overridden keys={overridden} name="reposDir" /></div>
              <div className="gx__rowSummary">每个仓库拉取到该目录下的同名子目录，观象只读使用。</div>
            </div>
            <div className="gx__rowCtl"><input className="gx__input gx__input--wide gx__mono" value={draft.reposDir} onChange={(event) => { setDraft({ ...draft, reposDir: event.target.value }) }} /></div>
          </div>
          <NumberRow label="更新间隔" summary="输入 /guanxiang 时，距上次拉取超过该时间的仓库会先更新；0 表示每次都更新。" unit="分钟" value={draft.fetchIntervalMin} overridden={overridden.includes('fetchIntervalMs')} onChange={(value) => { setDraft({ ...draft, fetchIntervalMin: value }) }} />
        </div>
      </section>
      <section className="gx__sec">
        <h2 className="gx__secTitle">派发</h2>
        <div className="gx__list">
          <NumberRow label="单次应用数上限" summary="一次派发最多同时分析的应用数，不应超过 DSH 的活动子 Agent 上限（默认 8）。" unit="个" value={draft.maxAppsPerRequest} overridden={overridden.includes('maxAppsPerRequest')} onChange={(value) => { setDraft({ ...draft, maxAppsPerRequest: value }) }} />
          <NumberRow label="派发超时" summary="等待全部子 Agent 的最长时间，超时后停止仍在运行的子 Agent。" unit="分钟" value={draft.dispatchTimeoutMin} overridden={overridden.includes('dispatchTimeoutMs')} onChange={(value) => { setDraft({ ...draft, dispatchTimeoutMin: value }) }} />
        </div>
      </section>
      <section className="gx__sec">
        <h2 className="gx__secTitle">SKILL 改进</h2>
        <div className="gx__list">
          <div className="gx__row">
            <div className="gx__rowText">
              <div className="gx__rowLabel">允许提出 SKILL 修改 <Overridden keys={overridden} name="skillUpdates" /></div>
              <div className="gx__rowSummary">子 Agent 发现应用的日志分析 SKILL 有欠缺时可以写出修改提议；经用户授权后，观象用访问令牌把它推送到新分支并创建合并请求（GitLab，令牌需要 write_repository 权限）。</div>
            </div>
            <div className="gx__rowCtl"><input type="checkbox" className="gx__check" aria-label="允许提出 SKILL 修改" checked={draft.skillUpdatesEnabled} onChange={(event) => { setDraft({ ...draft, skillUpdatesEnabled: event.target.checked }) }} /></div>
          </div>
          <NumberRow label="提议文件数上限" unit="个" value={draft.skillMaxFiles} onChange={(value) => { setDraft({ ...draft, skillMaxFiles: value }) }} />
          <NumberRow label="提议单文件大小上限" unit="KB" value={draft.skillMaxKb} onChange={(value) => { setDraft({ ...draft, skillMaxKb: value }) }} />
        </div>
      </section>
      <section className="gx__sec">
        <h2 className="gx__secTitle">面板设置</h2>
        <div className="gx__list">
          <div className="gx__row">
            <div className="gx__rowText">
              <div className="gx__rowLabel">恢复 cordis.yml 配置</div>
              <div className="gx__rowSummary">删除面板保存的全部设置（$DSH_HOME/guanxiang/settings.json 中的覆盖值）。</div>
            </div>
            <div className="gx__rowCtl"><button type="button" className="gx__btn gx__btn--danger" disabled={busy || overridden.length === 0} onClick={onReset}>恢复</button></div>
          </div>
        </div>
      </section>
    </>
  )
}

function NumberRow({ label, summary, unit, value, overridden = false, onChange }: { label: string; summary?: string; unit: string; value: string; overridden?: boolean; onChange: (value: string) => void }): JSX.Element {
  return (
    <div className="gx__row">
      <div className="gx__rowText">
        <div className="gx__rowLabel">{label}{overridden ? <span className="gx__tag gx__tag--accent">面板设置</span> : null}</div>
        {summary === undefined ? null : <div className="gx__rowSummary">{summary}</div>}
      </div>
      <div className="gx__rowCtl">
        <input className="gx__input gx__input--num" inputMode="decimal" value={value} onChange={(event) => { onChange(event.target.value) }} />
        <span className="gx__unit">{unit}</span>
      </div>
    </div>
  )
}
