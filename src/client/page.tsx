/**
 * 左侧栏「观象」主区页面：应用仓库、日志下载、高级三个分页，共用一份草稿和
 * 底部保存条。仓库拉取中时每 2 秒刷新状态。
 *
 * @module dsh-guanxiang/client/page
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { EditableKey, EditableSettings, RepoSpec, RepoStatusWire, StateWire } from '../settings/contract.ts'
import { fetchState, messageOf, resetSettings, saveSettings, syncRepos } from './api.ts'

/** Sidebar label and page title. */
export const PANEL_TITLE = '观象'

const MB = 1024 * 1024
const MINUTE = 60 * 1000

type TabId = 'repos' | 'download' | 'advanced'

const TABS: readonly { id: TabId; label: string }[] = [
  { id: 'repos', label: '应用仓库' },
  { id: 'download', label: '日志下载' },
  { id: 'advanced', label: '高级' },
]

/** Editable text form of the settings. */
interface Draft {
  reposDir: string
  repos: RepoSpec[]
  fetchIntervalMin: string
  maxAppsPerRequest: string
  dispatchTimeoutMin: string
  allowedHosts: string[]
  maxMb: string
  timeoutSec: string
}

function trimNumber(value: number): string {
  return String(Math.round(value * 100) / 100)
}

function toDraft(settings: EditableSettings): Draft {
  return {
    reposDir: settings.reposDir,
    repos: settings.repos.map(repo => ({ ...repo })),
    fetchIntervalMin: trimNumber(settings.fetchIntervalMs / MINUTE),
    maxAppsPerRequest: String(settings.maxAppsPerRequest),
    dispatchTimeoutMin: trimNumber(settings.dispatchTimeoutMs / MINUTE),
    allowedHosts: [...settings.download.allowedHosts],
    maxMb: trimNumber(settings.download.maxBytes / MB),
    timeoutSec: trimNumber(settings.download.timeoutMs / 1000),
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
  return {
    reposDir: draft.reposDir.trim(),
    repos: draft.repos.map(repo => repo.branch === undefined || repo.branch.trim() === '' ? { url: repo.url.trim() } : { url: repo.url.trim(), branch: repo.branch.trim() }),
    fetchIntervalMs: Math.round(positive(draft.fetchIntervalMin, '更新间隔', true) * MINUTE),
    maxAppsPerRequest: maxApps,
    dispatchTimeoutMs: Math.round(positive(draft.dispatchTimeoutMin, '派发超时') * MINUTE),
    download: {
      allowedHosts: draft.allowedHosts.map(host => host.trim()).filter(host => host !== ''),
      maxBytes: Math.round(positive(draft.maxMb, '单文件大小上限') * MB),
      timeoutMs: Math.round(positive(draft.timeoutSec, '下载超时') * 1000),
    },
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

  const run = async (action: () => Promise<StateWire>, success: string, resetDraft: boolean): Promise<void> => {
    setBusy(true)
    setNotice(undefined)
    try {
      adopt(await action(), resetDraft)
      setNotice({ kind: 'ok', text: success })
    } catch (error) {
      setNotice({ kind: 'error', text: messageOf(error) })
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
        {tab === 'download' ? <DownloadTab draft={draft} setDraft={setDraft} overridden={state.overridden} /> : null}
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
      <p className="gx__secFoot">使用本机已有的 git 凭据（SSH key 或 credential helper）拉取，不留分支时跟随远端默认分支。每个仓库需包含 <span className="gx__mono">.dsh/guanxiang.yaml</span> 与其中声明的日志分析 SKILL。删除地址不会删除本地目录。</p>
      {state.repos.length > 0 ? <div><button type="button" className="gx__btn" disabled={busy} onClick={() => { onSync() }}>重新拉取全部</button></div> : null}
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
