# 应用仓库接入指南

本文写给应用代码仓库的维护者：一个应用要被观象分析，仓库里需要放什么、观象那边需要配什么。以观象 0.1.0 为准。

## 分工

观象只负责识别与派发；怎么分析某个应用的日志，由应用仓库自己的 SKILL 决定。

| 谁 | 做什么 |
|---|---|
| 应用仓库 | 提供应用描述 `.dsh/guanxiang.yaml` 和日志分析 SKILL `.dsh/skills/<skill>/SKILL.md`，推送到观象跟踪的分支 |
| 观象部署方 | 在 DSH Web 左侧栏的「观象」设置面板里填 git 地址，按需配置访问令牌、日志下载白名单和 SKILL 改进 |
| 观象插件 | 拉取仓库、生成应用目录、下载日志、在应用代码的只读快照里启动子 Agent，并汇总各应用的结论 |

## 接入清单

1. 在仓库里新增 `.dsh/guanxiang.yaml`，见[应用描述](#应用描述)。
2. 在仓库里新增 `.dsh/skills/<skill>/SKILL.md`，见[日志分析 SKILL](#日志分析-skill)。
3. 把这两个文件推送到观象跟踪的分支（默认是远端默认分支）。观象读取的是远端最新提交，不读任何本地检出。
4. 在设置面板「应用仓库」中添加 git 地址；https 私有仓库另在「访问令牌」中配置令牌，见[在设置面板接入](#在设置面板接入)。
5. 日志以对象存储链接提供时，在「日志下载」中加入该域名。
6. 面板中该仓库显示为可用后，发一条 `/guanxiang <问题>`，附上日志试跑。

## 最小示例

```
order-service/
├── .dsh/
│   ├── guanxiang.yaml
│   └── skills/
│       └── log-analysis/
│           └── SKILL.md
└── src/ …
```

`.dsh/guanxiang.yaml`：

```yaml
id: order-service
name: 订单服务
description: 下单、库存扣减与支付回调
aliases: [订单, 下单]
logHints: [order-service, OrderController]
skill: log-analysis
```

`.dsh/skills/log-analysis/SKILL.md`：

```markdown
---
name: log-analysis
description: 订单服务的日志分析流程：解压日志包、定位异常、对照本仓库代码给出根因。
---

# 订单服务日志分析

仓库只读；解压和中间文件只放在任务消息给出的运行目录。

## 1. 准备日志
- `.tar.gz` / `.tgz`：`tar -xzf <日志包> -C <运行目录>`
- `.zip`：`unzip -o <日志包> -d <运行目录>`
- 纯文本日志直接读取，不要复制。

## 2. 定位异常
- 日志格式：`时间 级别 [线程] [traceId] 类名 - 消息`。
- 先按时间范围和订单号、traceId 用 `grep` 过滤，再看第一条 `ERROR` / `Caused by`。

## 3. 对照代码
- `com.example.order.*` 位于 `src/main/java/com/example/order/`。
- `InventoryClient` 返回 503 或超时属于库存服务问题，不是本服务缺陷。
```

完整的可运行示例（含示例日志和代码）见 [examples/order-service](../examples/order-service)。

## 应用描述

`.dsh/guanxiang.yaml` 放在仓库根目录下，必须是普通文件（不能是符号链接）。

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 小写短横线格式，如 `order-service`。派发和分析请求按它找到应用，在所有接入的仓库中必须唯一 |
| `name` | 是 | 显示名，也是子 Agent 的标签，如「订单服务分析」 |
| `description` | 是 | 一句话说明应用负责什么，出现在入口 SKILL 的应用目录里 |
| `aliases` | 否 | 用户对这个应用的其他叫法，如中文名简称、英文名 |
| `logHints` | 否 | 能从日志里认出本应用的字符串，如服务名、主类名、日志 tag |
| `skill` | 是 | 日志分析 SKILL 名，小写短横线格式；对应 `.dsh/skills/<skill>/SKILL.md` |

规则：

- 观象每次加载 `/guanxiang` 时先 `git fetch`，再从跟踪分支的最新提交读取应用描述。改了描述或 SKILL，推送后下一次 `/guanxiang` 就生效，不用重启。
- 一个仓库对应一个应用。多个仓库声明同一个 `id` 时，这几个仓库全部不可用。
- 描述不合法、SKILL 缺失或设置了 `user-invocable: false` 时，应用不可用，原因显示在设置面板。

## 日志分析 SKILL

### 硬性要求

- 路径是 `.dsh/skills/<skill>/SKILL.md`，`<skill>` 与 `guanxiang.yaml` 的 `skill` 字段相同，必须是普通文件。
- frontmatter 的 `name` 也要等于 `<skill>`。DSH 按 frontmatter 的 `name` 注册 SKILL，观象派发时用 `/<skill>` 加载它，名称不一致时子 Agent 加载不到。`description` 必填。
- 不能设置 `user-invocable: false`，否则 `/<skill>` 无法加载，观象会把应用标为不可用。
- 可以设置 `disable-model-invocation: true`：开发者在本仓库里使用 dsh 时模型就不会自行加载它，观象的 `/<skill>` 加载不受影响。
- SKILL 目录里可以放 `scripts/`、`references/` 等辅助文件，子 Agent 可以读取和执行，但它们的输出只能写到运行目录。

### 子 Agent 收到什么

观象为每个应用启动一个子 Agent，工作目录是应用仓库在分析时那个提交的只读快照。它的首条消息大致如下：

```
/log-analysis

你是观象派发的日志分析子任务，负责应用「订单服务」（id: `order-service`）。当前工作目录是该应用的代码仓库，检出提交 `3f2a9c1e0b7d`。

## 问题
（父 Agent 整理的现象、时间、关键标识和用户原话要点）

## 日志
- `/…/.guanxiang/runs/<runId>/1-order-service/1-app.tar.gz`（下载自 https://oss.example.com/…）；只看本应用相关部分：tag=order

## 工作约束
- 应用仓库只读 …
- 解压结果和中间文件只放在运行目录 `/…/.guanxiang/runs/<runId>/1-order-service`。

## 返回格式
结论、关键证据、时间线、假设与待验证、建议，五部分。
```

- 日志一律是绝对路径。附件和本机文件直接给原路径；对象存储链接由观象下载到运行目录。日志包不会被预先解压。
- 一个文件混有多个应用的输出时，会附带 `filter` 说明如何区分。
- 返回格式由观象固定。SKILL 的「输出」部分只补充本应用特有的要求（比如证据中写哪些标识），不要另定一套结构。

### 写作要点

- **先写解压。** 按本应用实际的日志包格式写清命令，解压目标一律是运行目录。仓库只读，解压到仓库里会失败。
- **只读，只写运行目录。** 不改仓库文件，不执行 git 写操作，不 `cd` 到别处写文件。
- **不要依赖需要审批的操作。** 子 Agent 不会弹出审批或提问，通过飞书使用时 dsh_channels 也不转发子 Agent 的审批。联网下载、安装依赖、写运行目录以外的位置、启动服务或容器这类操作会直接失败。需要的工具（`tar`、`unzip`、`rg`、`jq` 等）要在运行 dsh 的机器上预先装好。
- **先过滤再阅读。** 日志可能很大，先按时间、traceId、订单号等用 `grep`/`rg` 缩小范围，不要通读或整体复制。
- **写清日志格式和代码地图。** 每行字段的含义、时间格式与时区、关键 logger 名对应的代码目录、调用链上的上下游服务。
- **写已知故障和排除规则。** 比如「库存服务 503 属于下游问题」。这部分是 SKILL 最有价值的内容，也是 [SKILL 改进](#skill-改进可选) 最常补充的内容。
- **说明版本对不上时怎么办。** 子 Agent 看的是跟踪分支的最新代码，日志可能来自更早的版本。日志里打印了版本号或提交号时，告诉子 Agent 在哪里找，并在结论中说明版本差异。

## 让观象认出你的应用

用户输入 `/guanxiang` 时一定走观象。没有输入时，只要有可用应用且 `autoInvoke` 开启（默认开启），模型也会在任务匹配时自行加载观象，比如用户说「帮我看下订单服务的报错日志」，或贴出带 `OrderController` 的堆栈。应用描述决定匹配效果：

- 模型看到的观象简介由各应用的 `name（id、aliases、logHints）` 拼接而成，**所有应用共用 500 字的上限**，放不下的应用只计数不列出。`aliases` 和 `logHints` 各写两三个最有区分度的词。
- `aliases` 写用户会说的叫法：中文简称、英文名、业务名。
- `logHints` 写日志开头几十行就会出现的字符串：服务名、进程名、日志 tag、主类名。入口 SKILL 只允许模型看日志开头几十行来判断归属。不要用 `ERROR`、`Exception` 这种所有应用都有的词。
- `description` 写这个应用负责的业务，出现在入口 SKILL 的应用目录表格里，帮助模型区分名字相近的应用。

日志明显不属于任何已注册应用时，模型按普通方式处理，不会派发。

## 在设置面板接入

DSH Web 左侧栏「观象」打开设置面板。面板保存的值写入 `$DSH_HOME/guanxiang/settings.json`，也可以在 profile 的 cordis.yml 中按 `id: guanxiang` 配置默认值（字段见 [README](../README.md#安装与配置)）。

| 分页 | 应用仓库需要的设置 |
|---|---|
| 应用仓库 | 填 git 地址，分支可选（默认跟随远端默认分支）。支持 https/http/ssh/git/file URL、`user@host:path` 和绝对路径。拉取后显示提交号、应用描述或不可用原因 |
| 访问令牌 | https 私有仓库需要。填地址前缀（如 `https://gitlab.example.com/team`）、用户名（默认 `oauth2`）和令牌名称，保存后再填令牌值 |
| 日志下载 | 日志以链接提供时，把对象存储域名加入白名单（同时允许其子域名） |
| 高级 | 拉取间隔、单次应用数上限、派发超时、SKILL 改进开关 |

### git 地址与令牌

- ssh 地址和 `user@host:path` 使用运行 dsh 的机器上已有的 SSH key，不需要令牌。
- https 地址使用「访问令牌」中前缀匹配的令牌；多个前缀匹配时取最长的。令牌值存在 DSH 凭据库，不进配置文件、命令行和模型上下文。需要 git 2.31 及以上。
- GitLab 令牌权限：只拉取时 `read_repository`；开启 SKILL 改进时 `write_repository`。不需要 `api`。
- **建议使用项目访问令牌**（或组访问令牌）：只覆盖要接入的应用仓库，设置过期时间。个人令牌能访问令牌主人有权限的所有项目，加了写权限后风险更大。

### 日志下载

- 只下载 http/https 链接，域名必须在白名单中，链接中不能带用户名和密码。
- 下载不带任何鉴权，私有存储要提供预签名链接或临时下载链接。
- 单文件大小和下载耗时有上限（默认 512 MiB、10 分钟），在「日志下载」中调整。

## SKILL 改进（可选）

观象可以把分析中发现的 SKILL 欠缺提交为合并请求。默认关闭，在设置面板「高级」→「SKILL 改进」开启。

流程：子 Agent 把修改后的完整文件和理由写到运行目录 → 观象校验并生成 diff → 父 Agent 在回复中展示改动并请求授权（飞书里是决策卡片，Web 里是审批提示）→ 用户点「允许」后，观象推送新分支 `guanxiang/skill-<应用 id>-<树对象前缀>` 并创建合入跟踪分支的合并请求。

前提与限制：

- **权限模式必须是「询问」类。** 会话的审批策略为 `never`（DSH「完全访问」模式）时授权请求一律被拒绝，不会推送。
- **只支持 GitLab。** 合并请求通过 GitLab push options 创建，其他服务器会拒绝这次推送。
- **令牌需要 `write_repository`**，ssh 地址使用本机 SSH key。合并请求以令牌主人的身份创建。
- **改动范围只限 `.dsh/skills/<skill>/`。** 观象不推送已有分支和默认分支，合并由仓库的评审流程决定，合并后下一次 `/guanxiang` 生效。

应用仓库维护者应当：

- 保护默认分支，要求合并请求评审后才能合入。
- 用 CODEOWNERS 等方式为 `.dsh/skills/` 指定评审人。
- 评审时留意改动内容。日志内容不可信，可能诱导模型写出不当的 SKILL；观象只限制改动范围，不判断内容。

## 自检与排错

设置面板「应用仓库」显示每个仓库的状态和不可用原因：

| 面板显示 | 处理 |
|---|---|
| 仓库缺少应用描述 `.dsh/guanxiang.yaml` | 确认文件已推送到跟踪分支，路径和文件名正确 |
| `.dsh/guanxiang.yaml` 不合法：… | 按提示修正字段，`id` 和 `skill` 只能是小写字母、数字和短横线 |
| 仓库缺少日志分析 SKILL `.dsh/skills/<skill>/SKILL.md` | 目录名要与 `skill` 字段一致 |
| … 设置了 `user-invocable: false` … | 删除该设置 |
| … 不是普通文件 | 把符号链接换成真实文件 |
| 多个仓库声明同一个应用 id | 给其中一个仓库换 `id` |
| 拉取失败（认证、令牌未设置） | 检查地址前缀、令牌名称和令牌权限，或本机 SSH key |

面板显示可用但子 Agent 没有按 SKILL 工作时，先检查 SKILL frontmatter 的 `name` 是否与 `skill` 字段一致。

本地试用可以先用 [examples/order-service](../examples/order-service)：把它复制出来初始化为 git 仓库，在面板添加它的绝对路径，然后按示例 README 中的消息试跑。
