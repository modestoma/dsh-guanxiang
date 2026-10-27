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
入口 SKILL（意图识别）── 应用目录由已拉取仓库的 .dsh/guanxiang.yaml 生成
        │  guanxiang_dispatch({ tasks: [{ app, question, logs }] })
        ▼
派发工具：校验应用 id → 下载 URL 日志 → 并行启动子 Agent，等待全部结束
        │  子 Agent 工作目录 = 应用仓库，首条消息以 /<skill> 开头加载该应用的日志分析 SKILL
        ▼
父 Agent 按应用分节汇总，涉及多个应用时给出跨应用的推演
```

- **一个入口。** 插件只提供用户斜杠入口 `/guanxiang`（模型不会自行加载）。dsh 在 Web、TUI、ACP 以及经 dsh_channels 的飞书消息中都能识别它。
- **派发由代码完成。** 模型只给出应用 id、问题和日志位置；仓库目录、应用 SKILL、并发上限都由插件决定。应用 id 必须与注册表一一对应，否则整次派发被拒绝。
- **日志一律以绝对路径交给子 Agent。** 附件和本机文件直接传路径；消息里的对象存储下载链接由派发工具下载（只允许白名单域名，不带鉴权，限制大小与耗时）。日志包不解压，由应用的日志分析 SKILL 在运行目录里解压。
- **运行目录。** 每次派发在父会话目录下创建 `.guanxiang/runs/<runId>/<序号>-<应用 id>/`，下载的日志放在这里，子 Agent 也只在这里写文件；应用仓库对子 Agent 只读。
- **等待式派发。** 工具等待所有子 Agent 结束后一次返回，一条消息对应一张完整回复；超过派发超时或调用被取消时停止仍在运行的子 Agent。子会话中不提供派发工具。

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
    fetchIntervalMs: 600000            # 派发前超过该时间的检出先更新
    maxAppsPerRequest: 4               # 单次派发的任务上限
    dispatchTimeoutMs: 1800000         # 等待全部子 Agent 的上限
    download:
      allowedHosts: [oss.example.com]  # 同时允许子域名；为空时不下载 URL
      maxBytes: 536870912
      timeoutMs: 600000
    subagentProvider: spawn            # 子 Agent 使用的 ctx.subagents provider
    gitTimeoutMs: 600000               # 单条 git 命令的超时
```

配置在加载时校验，不合法时插件加载失败。git 地址支持 https/http/ssh/git/file URL、`user@host:path` 和绝对路径，拉取时使用本机已有的 git 凭据（SSH key 或 credential helper），插件不保存密码或 token，也不会弹出交互式输入。

子 Agent 的命令在 dsh 的文件沙箱中运行：仓库只读，只有父会话的项目目录可写，运行目录就在其中。Linux 的 bubblewrap 沙箱会把 `/tmp` 换成空的临时目录，所以 `reposDir` 不要放在 `/tmp` 下，否则子 Agent 的命令看不到仓库。

### 设置面板

DSH Web 左侧栏的「观象」入口打开整页设置面板：

| 分页 | 内容 |
|---|---|
| 应用仓库 | git 地址列表（分支可选）、每个仓库的拉取状态、提交号、应用描述与不可用原因，单个或全部重新拉取 |
| 日志下载 | 允许下载的域名、单文件大小上限、下载超时 |
| 高级 | 拉取目录、更新间隔、单次应用数上限、派发超时，恢复 cordis.yml 配置 |

面板保存的值写入 `$DSH_HOME/guanxiang/settings.json`（只保存与 cordis.yml 不同的字段），按与配置相同的规则校验。面板接口 `/guanxiang/*` 使用 DSH 自己的登录与来源校验，写操作另做同源校验。

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

插件拉取仓库后检查这两个文件；缺失、不合法，或多个仓库声明同一个 id 时，相关应用不可用，原因显示在设置面板。删除地址不会删除本地检出；有子 Agent 正在分析的仓库不会被更新，分析结束后补做更新。

## 通过飞书使用

观象与 [dsh_channels](https://github.com/modestoma/dsh_channels) 没有代码耦合。dsh_channels 把不在自己命令表中的 `/` 开头消息作为普通 prompt 交给 dsh，dsh 识别 `/guanxiang` 后展开入口 SKILL。飞书附件的宿主路径会出现在消息里，入口 SKILL 会把它作为日志路径派发。

## 开发

```sh
pnpm install
pnpm check        # 类型检查（Host 与 Client）+ 单元测试 + 构建 + 两个加载自检
```

## 发布

版本号由 semantic-release 按 Conventional Commits 计算，**只在手动触发时发布**；推送到 `main` / `dev` 只跑检查，可以先累积多笔提交。PR 标题需符合 `<type>(<scope>): <summary>`，type 取 `feat | fix | docs | test | refactor | chore | ci`。

| 分支 | 版本 | npm dist-tag |
| --- | --- | --- |
| `main` | 正式版，如 `0.1.0` | `latest` |
| `dev` | 预发布版，如 `0.1.0-beta.1` | `beta` |

在 GitHub Actions 的 `pipeline` workflow 点击 **Run workflow**，选择 `main` 或 `dev`：`dry_run` 默认勾选，只预览下一个版本号；取消勾选才真正发布 npm 包、打 tag 并创建 GitHub Release。安装 beta 版用 `@modesto_ma/dsh-guanxiang@beta`。

| 路径 | 内容 |
|---|---|
| `src/index.ts` | Cordis 插件入口 |
| `src/service.ts` | 生效设置、注册表、入口 SKILL 与派发工具的注册 |
| `src/repos/` | git 拉取、应用描述校验、应用注册表 |
| `src/skill/entry.ts` | `/guanxiang` 入口 SKILL |
| `src/dispatch/` | 派发工具、日志下载、子 Agent 首条消息 |
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
