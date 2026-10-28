/**
 * 设置面板与 Host 路由共用的路由常量和 JSON 结构。浏览器端 bundle 也会
 * 编译本文件，因此这里只放类型和常量，不 import 任何 Node 模块。
 *
 * @module dsh-guanxiang/settings/contract
 */

/** GET：面板所需的全部状态（生效设置、默认值、仓库与应用）。 */
export const STATE_ROUTE = '/guanxiang/state'
/** PUT：保存可编辑设置；DELETE：清除面板覆盖、恢复 cordis.yml 默认值。 */
export const SETTINGS_ROUTE = '/guanxiang/settings'
/** POST：立即重新拉取全部仓库，或 body `{ url }` 指定的一个仓库。 */
export const SYNC_ROUTE = '/guanxiang/sync'
/** PUT：body `{ tokenEnv, value }` 把令牌存入 DSH 凭据库；DELETE：body `{ tokenEnv }` 删除已存的值。只接受已保存的访问令牌配置引用的名称。 */
export const TOKEN_ROUTE = '/guanxiang/token'

/** One configured application repository. */
export interface RepoSpec {
  /** Git remote address, cloned with the host machine's existing git credentials or a matching {@link GitCredentialSpec}. */
  url: string
  /** Remote branch to follow; omitted follows the remote's default branch. */
  branch?: string
}

/** Credential reference grammar of `@deepseek-ai/dsh-credentials` (a POSIX shell identifier), which {@link GitCredentialSpec.tokenEnv} follows. */
export const TOKEN_ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** HTTPS access token used for the repositories under one address prefix. */
export interface GitCredentialSpec {
  /** `https://host[:port][/path]` (or `http://`) prefix; repository addresses under it use this token. */
  url: string
  /** HTTP username sent with the token; GitLab personal access tokens accept `oauth2`. */
  username: string
  /** Credential reference (environment-variable name) whose value in DSH's credential store is the token. */
  tokenEnv: string
}

/** Log URL download policy. */
export interface DownloadSettings {
  /** Allowed host names; `example.com` also admits its subdomains. Empty disables URL downloads. */
  allowedHosts: string[]
  /** Per-file byte ceiling. */
  maxBytes: number
  /** Per-file download timeout in milliseconds. */
  timeoutMs: number
}

/** Application SKILL improvement proposals that children may write and the top-level agent may submit as merge requests. */
export interface SkillUpdateSettings {
  /** Whether children are told how to propose SKILL changes and top-level agents are offered `guanxiang_propose_skill`. */
  enabled: boolean
  /** Most files one proposal may add or change. */
  maxFiles: number
  /** Largest proposed file, in bytes. */
  maxFileBytes: number
}

/** The settings the Web panel can override; every field is required on the wire. */
export interface EditableSettings {
  /** Absolute directory holding the cloned repositories (`~` expands to the home directory). */
  reposDir: string
  /** Application repositories to clone and keep updated. */
  repos: RepoSpec[]
  /** HTTPS access tokens by address prefix; the token values stay in DSH's credential store. */
  gitCredentials: GitCredentialSpec[]
  /** Minimum age of a repository's last sync before loading `/guanxiang` syncs it again, in milliseconds; 0 syncs on every load. */
  fetchIntervalMs: number
  /** Maximum number of child analyses one dispatch may start. */
  maxAppsPerRequest: number
  /** Whole-dispatch wait budget in milliseconds; children still running then are stopped. */
  dispatchTimeoutMs: number
  /** URL download policy. */
  download: DownloadSettings
  /** SKILL improvement proposals. */
  skillUpdates: SkillUpdateSettings
}

/** Keys of {@link EditableSettings}, in panel order. */
export const EDITABLE_KEYS = ['reposDir', 'repos', 'gitCredentials', 'fetchIntervalMs', 'maxAppsPerRequest', 'dispatchTimeoutMs', 'download', 'skillUpdates'] as const satisfies readonly (keyof EditableSettings)[]

/** One editable key. */
export type EditableKey = (typeof EDITABLE_KEYS)[number]

/** Application description read from `<repo>/.dsh/guanxiang.yaml`. */
export interface AppManifest {
  /** Registry id the dispatch tool and analysis requests address. */
  id: string
  /** Display name, also the child agent's label. */
  name: string
  /** What the application does, used for intent recognition. */
  description: string
  /** Other names users call the application by. */
  aliases: string[]
  /** Strings that identify this application's log lines (tags, process names, class names). */
  logHints: string[]
  /** Project skill name under `.dsh/skills/<skill>/SKILL.md` that analyzes this application's logs. */
  skill: string
}

/** Lifecycle of one repository checkout. */
export type RepoPhase = 'pending' | 'syncing' | 'ready' | 'failed'

/** One repository as the panel shows it. */
export interface RepoStatusWire {
  url: string
  branch?: string
  /** Absolute directory of the fetch-only clone; children work in commit snapshots under `<reposDir>/.snapshots/`. */
  dir: string
  phase: RepoPhase
  /** Latest synced commit, the one the catalog describes and new dispatches use. */
  commit?: string
  /** Committer date of {@link commit}, ISO 8601. */
  commitTime?: string
  /** Last completed sync attempt, epoch milliseconds. */
  syncedAt?: number
  /** Application description read from {@link commit}. */
  app?: AppManifest
  /** Why the repository is unusable (`failed`), or why the last update failed while an older commit stays usable (`ready`). */
  error?: string
  /** Whether the application is offered to intent recognition and dispatch. */
  available: boolean
  /** Child analyses currently running in snapshots of this repository. */
  activeRuns: number
}

/** Whether one referenced token has a value — never the value. */
export interface TokenStatusWire {
  tokenEnv: string
  /** Whether resolving the reference currently returns a value. */
  configured: boolean
  /** Credential store layer supplying the value (`file`, `env`, `project-env`, `user-env`); absent while unconfigured. */
  source?: string
  /** Whether the panel can store a value for this reference. */
  writable: boolean
  /** Why the credential store could not describe the reference. */
  error?: string
}

/** Credential store view of the panel. */
export interface CredentialsWire {
  /** Whether the DSH composition provides `ctx.credentials`; without it tokens cannot be stored or read. */
  available: boolean
  /** One entry per distinct `tokenEnv` of the effective settings; empty while unavailable. */
  tokens: TokenStatusWire[]
}

/** `GET /guanxiang/state` response. */
export interface StateWire {
  /** Effective settings: cordis.yml values with panel overrides applied. */
  settings: EditableSettings
  /** cordis.yml values before panel overrides. */
  defaults: EditableSettings
  /** Keys the panel currently overrides. */
  overridden: EditableKey[]
  /** Why the overlay file was ignored (unreadable or invalid); panel saves replace it. */
  overlayError?: string
  repos: RepoStatusWire[]
  credentials: CredentialsWire
}

/** Successful mutation response. */
export interface MutationOk {
  ok: true
  state: StateWire
}

/** Failed request response. */
export interface MutationError {
  ok: false
  error: string
}
