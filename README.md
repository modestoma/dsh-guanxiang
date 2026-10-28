# 观象 GuanXiang

> **观其象，知其因。**

观象是面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的日志分析插件。

名称取意于《周易》的观象思想：以日志为象，以推理为径，从复杂的系统运行痕迹中洞察异常、关联线索、追溯根因。

中文名统一使用「观象」，英文品牌统一使用「GuanXiang」。

## 项目状态

初版（未发布到 npm）：打通「`/guanxiang` 入口 → 识别应用 → 派发子 Agent 到应用代码仓库 → 汇总结论」这条链路，附带一个示例应用仓库。接口仍可能调整。

## 核心能力

观象的能力按名称拆分为三个层次，由浅入深：

| 能力 | 关注点 | 规划内容 |
|---|---|---|
| **观** | 看见 | 解析日志、提取线索、发现异常 |
| **象** | 理解 | 理解系统行为、关联事件、构建问题全貌 |
| **推演** | 求因 | 借助 AI Agent 自主分析、验证假设、定位根因 |

### 观：解析日志，发现异常

- 解析常见的结构化与半结构化日志格式，统一为可检索的事件记录。
- 提取时间、级别、模块、请求标识、错误信息等关键字段作为线索。
- 识别错误突增、异常堆栈、频率偏离等可疑信号。

### 象：关联事件，构建全貌

- 按时间线、请求链路和组件关系关联分散的日志事件。
- 将多个异常信号归并为同一问题，还原问题发生的上下文。
- 呈现系统在问题时段内的行为全貌，为后续推演提供依据。

### 推演：自主分析，定位根因

- 由 AI Agent 基于「观」与「象」的结果提出根因假设。
- 主动检索更多日志与上下文，对假设逐一验证或排除。
- 输出可追溯的分析过程与结论，说明每个判断所依据的日志证据。

## 工作方式

观象是分体结构：插件只负责识别与派发，各应用的日志分析知识跟着应用代码放在应用自己的仓库里。

```
用户：/guanxiang 订单服务昨晚 21 点下单报 500，日志见附件
        │
        ▼
入口 SKILL（意图识别）── 先 fetch 各仓库，应用目录由远端最新提交的 .dsh/guanxiang.yaml 生成
        │  guanxiang_dispatch({ tasks: [{ app, question, logs }] })
        ▼
派发工具：校验应用 id → 下载 URL 日志 → 并行启动子 Agent，等待全部结束
        │  子 Agent 工作目录 = 应用仓库，首条消息以 /<skill> 开头加载该应用的日志分析 SKILL
        ▼
父 Agent 按应用分节汇总，涉及多个应用时给出跨应用的推演
```

- **一个入口，两种触发。** 入口 SKILL 是 `/guanxiang`，dsh 在 Web、TUI、ACP 以及经 dsh_channels 的飞书消息中都能识别它。有可用应用且 `autoInvoke` 开启（默认）时，模型也能自行加载：dsh 给顶层 Agent 的 skill 目录里，观象的描述会列出每个可用应用的名称、id、别名和日志特征（总长不超过 500 字，放不下的只计数），用户说「分析这份订单服务的日志」或贴出带 `OrderController` 的报错时，模型会先加载观象。日志明显不属于任何已注册应用时，入口 SKILL 让模型按普通方式处理，不派发也不追问。子 Agent 的工作目录在 `reposDir` 内，那里不列出观象。应用增删时 dsh 会追加一条新的 skill 目录消息；想要确定触发时仍用 `/guanxiang`。
- **派发由代码完成。** 模型只给出应用 id、问题和日志位置；仓库目录、应用 SKILL、并发上限都由插件决定。应用 id 必须与注册表一一对应，否则整次派发被拒绝。
- **日志一律以绝对路径交给子 Agent。** 附件和本机文件直接传路径；消息里的对象存储下载链接由派发工具下载（只允许白名单域名，不带鉴权，限制大小与耗时）。日志包不解压，由应用的日志分析 SKILL 在运行目录里解压。
- **应用目录随时最新。** 每次加载 `/guanxiang` 都先 `git fetch` 各仓库（间隔由 `fetchIntervalMs` 控制，默认每次），再从远端分支最新提交的 git 对象读取应用描述生成应用目录。fetch 不改动任何检出，所以正在进行的分析不会挡住更新。最多等待 `refreshWaitMs`，超时就先用已有的目录，fetch 在后台继续。
- **代码快照不可变。** 子 Agent 在 `<reposDir>/.snapshots/<仓库名>/` 下按提交创建的 `git worktree` 快照里工作。快照创建后不再改动，同一提交的派发共用一份；没有分析在用、且已不是最新提交的快照会被删除。
- **运行目录。** 每次派发在父会话目录下创建 `.guanxiang/runs/<runId>/<序号>-<应用 id>/`，下载的日志放在这里，子 Agent 也只在这里写文件；应用仓库对子 Agent 只读。
- **等待式派发。** 工具等待所有子 Agent 结束后一次返回，一条消息对应一张完整回复；超过派发超时或调用被取消时停止仍在运行的子 Agent。子会话中不提供派发工具。
- **SKILL 改进（可选，默认关闭）。** 子 Agent 发现应用的日志分析 SKILL 有欠缺时，可以在运行目录写出修改提议；经用户授权后，观象把它推送到应用仓库的新分支并创建合并请求，见 [SKILL 改进](#skill-改进)。

## 安装与配置

观象以 dsh bundle 交付（`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`），Host 半侧运行 `lib/index.js`，浏览器半侧运行 `lib/client.js`。

安装已发布的 npm 版本（推荐）：

```bash
# 在 deepseek-harness 仓库内：把 npm 包安装进 web profile
DSH_HOME=$DSH_HOME pnpm dsh plugin --profile web add @modesto_ma/dsh-guanxiang
```

本地 checkout 开发时：

```bash
pnpm build
DSH_HOME=$DSH_HOME pnpm dsh plugin --profile web add link:/path/to/dsh-guanxiang
```

npm 发行包已包含构建产物；本地 `link:` 安装前必须先执行 `pnpm build`。安装或修改后重启 dsh。包内的 `cordis.patch.yml` 把 `@modesto_ma/dsh-guanxiang` 加入 profile 的 bundle 列表，并提供稳定 `id: guanxiang` 的 Loader 行。可在 profile 的 patch 中按该 id 配置默认值：

```yaml
- id: guanxiang
  config:
    reposDir: ~/.dsh/guanxiang/repos   # 默认 $DSH_HOME/guanxiang/repos
    repos:
      - url: git@github.com:example/order-service.git
      - url: https://github.com/example/pay-service.git
        branch: release                # 可选，默认跟随远端默认分支
    gitCredentials:                    # https 仓库的访问令牌，只写令牌名称，不写令牌值
      - url: https://gitlab.example.com  # 地址前缀；其下的 https 仓库使用该令牌
        username: oauth2               # 可选，默认 oauth2
        tokenEnv: GITLAB_TOKEN         # DSH 凭据库中的令牌名称，也可以是同名环境变量
    fetchIntervalMs: 0                 # 加载 /guanxiang 时距上次拉取超过该时间的仓库先 fetch；0 = 每次
    maxAppsPerRequest: 4               # 单次派发的任务上限
    dispatchTimeoutMs: 1800000         # 等待全部子 Agent 的上限
    download:
      allowedHosts: [oss.example.com]  # 同时允许子域名；为空时不下载 URL
      maxBytes: 536870912
      timeoutMs: 600000
    subagentProvider: spawn            # 子 Agent 使用的 ctx.subagents provider
    gitTimeoutMs: 600000               # 单条 git 命令的超时
    refreshWaitMs: 15000               # 加载 /guanxiang 时等待 fetch 的上限；0 = 不等待
    autoInvoke: true                   # 任务匹配已注册应用时模型可自行加载入口 SKILL；false = 只能输入 /guanxiang
    skillUpdates:                      # SKILL 改进，见下文
      enabled: false                   # 默认关闭
      maxFiles: 16                     # 一次提议最多新增或修改的文件数
      maxFileBytes: 262144             # 提议中单个文件的大小上限
    skillUpdateAuthor:                 # 可选：SKILL 改进提交的作者；省略时使用本机 git 的 user.name / user.email
      name: 观象
      email: guanxiang@example.com
```

配置在加载时校验，不合法时插件加载失败。git 地址支持 https/http/ssh/git/file URL、`user@host:path` 和绝对路径，拉取时使用本机已有的 git 凭据（SSH key 或 credential helper），不会弹出交互式输入。

### 访问令牌

用 https 地址拉取 GitLab 等私有仓库时，可以配置个人访问令牌（GitLab 需要 `read_repository` 权限；开启 [SKILL 改进](#skill-改进) 时需要 `write_repository`）：

- **配置只写名称。** `gitCredentials` 的每一项把一个地址前缀（`https://主机[:端口][/路径]`）对应到一个令牌名称 `tokenEnv`；地址在前缀下的 https 仓库使用该令牌，多个前缀匹配时取路径最长的。ssh、`user@host:path` 和本地路径不受影响。
- **令牌值在 DSH 凭据库。** 令牌通过 DSH 的 `ctx.credentials` 读取（默认组合加载的 `@deepseek-ai/dsh-credentials-local`，文件 `$DSH_HOME/.credentials.yaml`，仅本机用户可读），可以在设置面板的「访问令牌」分页保存，也可以设置同名环境变量或写进 `.env`。每次拉取都重新读取，更换令牌不用重启。面板接口只接受已保存的配置引用的名称，也从不返回令牌值。
- **只交给 git。** 拉取时令牌经环境变量交给这一次的 git 进程，由只对该主机生效的凭据助手在服务器要求认证时提供，本机为该主机配置的其他凭据助手不参与；令牌不出现在命令行参数、`.git/config`、日志或模型上下文里。需要 git 2.31 及以上版本。
- **缺失时明确报错。** 地址匹配了令牌配置但令牌未设置，或 DSH 组合没有凭据服务时，该仓库拉取失败，原因显示在设置面板。

凭据库文件只防其他系统用户。与 DSH 中的模型 API Key 一样，Agent 的命令以同一系统用户运行，文件权限不能把令牌与 Agent 隔离（见 `@deepseek-ai/dsh-credentials-local` 文档）；建议使用只读权限、设置过期时间的令牌。

子 Agent 的命令在 dsh 的文件沙箱中运行：仓库只读，只有父会话的项目目录可写，运行目录就在其中。Linux 的 bubblewrap 沙箱会把 `/tmp` 换成空的临时目录，所以 `reposDir` 不要放在 `/tmp` 下，否则子 Agent 的命令看不到仓库。

拉取目录 `<reposDir>/<仓库名>` 只用来 fetch，新克隆不检出文件（旧版本留下的检出文件不再使用）。多个同时运行的 dsh 进程不要共用同一个 `reposDir`：进程启动后首次同步时会删除快照目录里的遗留快照。

### 设置面板

DSH Web 左侧栏的「观象」入口打开整页设置面板：

| 分页 | 内容 |
|---|---|
| 应用仓库 | git 地址列表（分支可选）、每个仓库的拉取状态、提交号、应用描述与不可用原因，单个或全部重新拉取 |
| 访问令牌 | https 地址前缀、用户名与令牌名称；保存后填入令牌，显示是否已设置及来源，可清除 |
| 日志下载 | 允许下载的域名、单文件大小上限、下载超时 |
| 高级 | 拉取目录、更新间隔、单次应用数上限、派发超时、SKILL 改进开关与提议上限，恢复 cordis.yml 配置 |

面板保存的值写入 `$DSH_HOME/guanxiang/settings.json`（只保存与 cordis.yml 不同的字段），按与配置相同的规则校验；令牌值不在其中，存入 DSH 凭据库。面板接口 `/guanxiang/*` 使用 DSH 自己的登录与来源校验，写操作另做同源校验。

## 应用仓库约定

每个应用仓库需要两样东西（完整示例见 [examples/order-service](examples/order-service)）：

`.dsh/guanxiang.yaml` 应用描述：

```yaml
id: order-service               # 小写短横线格式，派发与分析请求按它对应应用
name: 订单服务                   # 显示名，也是子 Agent 的标签
description: 下单、库存扣减与支付回调
aliases: [订单, 下单, order]     # 用户对它的其他叫法
logHints: [order-service, OrderController]   # 能识别本应用日志的字符串
skill: log-analysis             # 对应 .dsh/skills/log-analysis/SKILL.md
```

`.dsh/skills/<skill>/SKILL.md`：这个应用的日志分析流程（如何解压日志包、日志格式、代码结构、常见问题）。它不能设置 `user-invocable: false`，因为派发时用 `/<skill>` 加载。

插件拉取仓库后检查这两个文件；缺失、不合法，或多个仓库声明同一个 id 时，相关应用不可用，原因显示在设置面板。应用描述和 SKILL 必须是普通文件，不能是符号链接。删除地址不会删除本地克隆，它的快照在没有分析使用后删除。

## SKILL 改进

开启 `skillUpdates.enabled`（设置面板「高级」→「SKILL 改进」）后，分析中发现的 SKILL 欠缺可以经用户授权后提交为合并请求：

1. **子 Agent 写提议。** 子 Agent 的任务消息多出一节说明：把要改的文件从 `.dsh/skills/<skill>/` 复制到运行目录的 `skill-proposal/files/`（保持相对路径）后修改，理由写进 `skill-proposal/reason.md`。仓库对子 Agent 仍然只读。
2. **派发结果标出提议。** 派发结束后，观象检查已完成任务的提议：只接受普通文件和受限的文件名、UTF-8 文本、文件数与大小上限，`SKILL.md` 不能设置 `user-invocable: false`。合格的提议在结果中给出改动行数，并在运行目录写出 `skill-proposal.diff`；不合格的给出原因。
3. **父 Agent 展示并提交。** 入口 SKILL 让父 Agent 在汇总回复后附上改动和 diff，再调用 `guanxiang_propose_skill`（参数为任务的运行目录和一句话摘要）。只接受本次 DSH 运行中由同一会话派发过的任务；应用、仓库和分析时的提交取自派发记录。
4. **请求授权。** 工具通过 DSH 的审批服务（`ctx.approval`，`@deepseek-ai/dsh-user-approval`）请求一次性授权，说明将推送的仓库、分支、目标分支、改动文件和理由。经 dsh_channels 使用时显示为飞书决策卡片，在 DSH Web 中显示为审批提示；观象与 dsh_channels 之间没有代码依赖。只有「允许」才推送；拒绝、撤回或没有可回答的界面时都不推送。会话的审批策略为 `never`（例如 DSH 的「完全访问」权限模式）时请求一律被拒绝，所以要在「询问」类权限模式下使用；DSH 组合没有审批服务时工具报错。
5. **推送新分支并创建合并请求。** 观象进程（不是 Agent）在拉取仓库中以分析时的提交为父提交生成提交，只改 `.dsh/skills/<skill>/` 下的文件，不动任何检出和快照；然后推送到新分支 `guanxiang/skill-<应用 id>-<树对象前缀>`，用 GitLab push options（`merge_request.create`、`merge_request.target`、`merge_request.title`、`merge_request.description`）创建合入跟踪分支的合并请求，返回服务器给出的合并请求链接。同一改动的分支已存在时不再请求授权，也不推送。从不推送已有分支或默认分支，合并由仓库的评审流程决定；合并后下次 `/guanxiang` 拉取即生效。

注意：

- 只支持 GitLab：不支持 push options 的服务器会拒绝这次推送。https 仓库的令牌需要 `write_repository`（不需要 `api`）；ssh 地址使用本机的 SSH key。
- 个人访问令牌加了写权限后，可以推送你有权限的所有项目。建议改用只覆盖应用仓库的项目或组访问令牌，设置过期时间，并保护应用仓库的默认分支。
- 合并请求以令牌主人的身份创建，提交作者是 `skillUpdateAuthor` 或本机 git 身份。飞书群里点「允许」的人可能不是令牌主人；合并请求描述写明了来源会话与分析提交。
- 日志内容不可信，可能诱导模型写出不当的 SKILL。观象只限制改动范围，内容需要授权的人和合并请求的评审者把关。

## 通过飞书使用

观象与 [dsh_channels](https://github.com/modestoma/dsh_channels) 没有代码耦合。dsh_channels 把不在自己命令表中的 `/` 开头消息作为普通 prompt 交给 dsh，dsh 识别 `/guanxiang` 后展开入口 SKILL。飞书附件的宿主路径会出现在消息里，入口 SKILL 会把它作为日志路径派发。

## 开发

```sh
pnpm install
pnpm check        # 类型检查（Host 与 Client）+ 单元测试 + 构建 + 两个加载自检
```

## 发布

版本号由 semantic-release 按 Conventional Commits 计算。推送到 `dev` 后，检查通过就自动发布 beta；正式版**只在手动触发时发布**，推送到 `main` 只跑检查。只有 `feat`、`fix` 或破坏性变更会产生新版本，其余类型的提交不发布。PR 标题需符合 `<type>(<scope>): <summary>`，type 取 `feat | fix | docs | test | refactor | chore | ci`。

| 分支 | 触发 | 版本 | npm dist-tag |
| --- | --- | --- | --- |
| `main` | 手动 | 正式版，如 `0.1.0` | `latest` |
| `dev` | 推送自动 | 预发布版，如 `0.1.0-beta.1` | `beta` |

发布正式版：在 GitHub Actions 的 `pipeline` workflow 点击 **Run workflow** 并选择 `main`。`dry_run` 默认勾选，只预览下一个版本号；取消勾选才真正发布 npm 包、打 tag 并创建 GitHub Release。在 `dev` 上手动触发同样可用，用来预览或补发 beta。安装 beta 版用 `@modesto_ma/dsh-guanxiang@beta`。

| 路径 | 内容 |
|---|---|
| `src/index.ts` | Cordis 插件入口 |
| `src/service.ts` | 生效设置、注册表、入口 SKILL 与派发工具的注册 |
| `src/repos/` | git 拉取、访问令牌、应用描述校验、应用注册表 |
| `src/skill/entry.ts` | `/guanxiang` 入口 SKILL |
| `src/dispatch/` | 派发工具、日志下载、子 Agent 首条消息 |
| `src/skill-update/` | SKILL 修改提议的校验、提交、授权与推送 |
| `src/settings/` | 面板契约、覆盖文件、HTTP 路由 |
| `src/client/` | 左侧栏入口与设置页面 |
| `examples/order-service/` | 示例应用仓库 |

## 路线图

- [x] 确定插件结构与 bundle 打包方式（分体派发初版）
- [ ] 按日志中的版本号切换应用代码版本
- [ ] 观：通用日志解析与异常检测工具，供各应用 SKILL 复用
- [ ] 象：事件关联与问题全貌
- [ ] 推演：Agent 驱动的根因分析
- [ ] 使用文档与示例

## 许可证

待定。
