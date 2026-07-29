# Agent Note：由启动器持有的会话身份与退出行

Status: implemented

[English](2026-07-28-launcher-owned-resume-identity.md) | 中文

## Problem

有两项本应由启动器持有的事实，却被作为 `dsh-tui-demo` 上的部署配置键交付：`resumeSessionId`（`main` 绑定到哪个会话）与 `resumeCommand`（退出提示的模板，其中 `{session}` 会被插值）。二者都不随部署而变——它们都是进程被如何调用的属性，而这一点只有启动器知道。

把它们经由 YAML 传递，使其可被静默丢弃。`@cordisjs/plugin-include` 施加定向补丁的方式是替换整个顶层键（`target[key] = value`），因此一份对 `tui-agent` 条目的 `config` 打补丁的个人 `~/.dsh/config.yaml`，会把交付时的整块内容整体替换掉。于是，一份为改动 provider 和 model 而写的用户 overlay，会删掉它未重述的每一个 resume 键，且没有任何东西报告这一点：缺失 `resumeCommand` 合法地意味着「未配置回退」。

两处失效在同一份真实的 overlay 中同时存在。退出提示不再打印，因为该 overlay 省略了 `resumeCommand`。更糟的是，该 overlay 带着 `resumeSessionId: !!js process.env.RESUME_SESSION_ID`——一行来自 [env 变量桥被移除](../../archived/architecture/2026-07-24-dsh-commander-argument-adapter.md)之前的陈旧代码——它用一次对某个无人设置的变量的读取，覆盖掉了交付时的 `!!js "typeof resumeSessionId === 'string' ? …"` 入口。此后 `dsh --resume <valid-id>` 会开启一个*全新*会话且什么都不说，并被直接复现：banner 显示的是一个新铸造的 id，而非所请求的那个。[`dsh meta`](../feature/2026-07-28-dsh-meta-source-workspace.md) note 曾把这次静默的 resume 记为一处无法解释的既有缺陷；而 overlay 的浅层替换正是其成因。

一个配置键无法安全地表达这些事实，因为部署方并非它们的权威。

## Decision

会话身份与退出行是由启动器持有的上下文槽位，在任何 Loader 条目挂载之前提供。二者都不出现在任何 `cordis.yml` 中，也不出现在 `dsh-tui` 或 `dsh-tui-demo` 的 `Config` 中。

`dsh-tui` 在既有的 `tuiResumeHost` 宿主能力旁声明这两个槽位，后者确立了先例——resume 宿主一直是一项被提供的能力，而非配置：

- `MAIN_SESSION_ID_KEY` 承载一个 `MainSessionIdentity`（`{ id: SessionId, resume: boolean }`）。`dsh-tui-demo` 把 TUI 与所配置的 agent 都绑定到 `id`，并且仅当 `resume` 被置位时才走加载历史的 `resumeSessionId` 路径，因为该路径要求存在一份日志、否则会明确报错。槽位缺失意味着没有启动器选定会话，于是应用铸造 `main-session-<uuid>` 并新建它。
- `TUI_GOODBYE_MESSAGE_KEY` 承载退出时终端释放后打印一次的完整行。缺失则什么都不打印。

`apps/cli` 铸造或选定 id，并依据它所复现的那次调用构建该行，与 `/resume` 的 execve 移交共用同一个 `resumeArgs` 助手，从而使打印出的命令与原地移交不会分歧。该行现在会在传入了 `--config` 时命名它，并在 meta 模式下复现 `dsh meta --resume <id>`——从而收口了 `dsh meta` note 所推迟的随 mode 变化的提示，在那里被复制的提示此前只有在检出目录中才有效。

**`ctx.provide` 是从启动器 argv 进入被 Loader 挂载的插件的唯一通道。** 配置的 `!!js` 表达式会以 `with (entry.ctx) { eval(expr) }`（`vendor/loader/src/config/utils.ts`）求值，因此一个裸标识符会针对该条目的上下文解析，别无它物可达。于是只要应用 bundle 仍从 YAML 挂载，这个槽位就无法被移除；变化之处在于它现在是启动器↔应用之间的内部管线，而不再是一个配置作者必须正确接线的、有文档记载的键。

该消息是一个纯字符串，而非回调。这迫使启动器在启动前就知道 id，也正是铸造从应用 bundle 中移出的原因——并且它让退出在终端释放之后免于任何被 await 的工作。

TUI 持有渲染，而非措辞：它在自己的 `palette.muted` 之前先应用 `displayText`，因此一个恶意的 `--config` 路径无法把终端转义序列注入退出行。做净化意味着启动器无法嵌入自己的 ANSI。

## Alternatives considered

**保留这些键，并在 `dsh-tui-demo` 中加入内建默认值。** 拒绝：代码中的默认值能在 overlay 下存活，但表达同一事实的两种途径依然并存，而配置作者仍可把键设错——这正是那行陈旧的 `process.env.RESUME_SESSION_ID` 使 resume 失效的方式。

**把 `dsh-tui-demo` 合并进 `apps/cli` 并彻底删除该槽位。** 经调查后拒绝，尽管这是移除该槽位的唯一途径。`examples/tui-agent/code-mode.cordis.yml` 通过一个嵌套的 `plugin-include` 给 `tui-agent` 条目打补丁，以切换 `tools.mode` 与人设，而 `examples/cordis-agent/cordis.yml` 把该 bundle 作为另一款产品复用；这两个扩展点都仅因 `tui-agent` 是一个声明式配置条目才存在。合并还会把一段 162 行、18 个依赖的组合逻辑挪进 CLI 的 `v8 ignore` 进程接线块中，脱离逐文件覆盖率门禁。

**把 goodbye 消息放到 `TuiResumeHost` 上。** 拒绝：退出行不是一项移交能力，而一个无法替换自身进程的宿主仍可能想要打印一行。它们是相互独立的槽位。

**让宿主只提供命令文本，而由 TUI 保留 `To resume this session:` 前缀。** 拒绝：TUI 将为一个它已不再理解的字符串保留 resume 词汇，而 meta 模式证明启动器才是唯一知道该命令应当说什么的组件。

**让 TUI 继续在会话被持久化之前抑制该行。** 拒绝：这项检查正是退出路径要查询持久化并吞掉列举失败的原因。一个纯字符串无法查询持久化，而误用现在会经由 `agent-loop/config-start-failed` 明确报错，而不是静默地恢复了个空。

**用一个回调（`goodbyeMessage(agent)`）让宿主能在退出时决定。** 拒绝：它会在 `ui.stop()` 之后恢复异步工作，为一个在启动时就已可知的字符串，重新引入拆解期间的挂起风险。

## Consequences

- 移除两个已发布的 `Config` 键是一次破坏性配置变更：一份命名了任一键的陈旧配置，现在会在启动时的 schema 校验中明确报错，而不再静默降级。这是有意为之，且在预发布阶段可以接受。
- `TuiResumeHost` 保持不变，但 `TuiRuntime` 新增 `goodbyeMessage`；`apps/cli` 是唯一的提供方。
- 即便某会话没有日志（启动后立即退出），退出行也会打印。此时使用它会明确报错，而不是开启一个意外的会话。这是丢弃持久化检查的有意代价。
- `dsh-tui` 完全不再读取 `sessionPersistence`：`currentResumeCommand`、`listWorkspaceSessions` 及其吞错路径都被删除，`/resume` 选择器的 `sessionQuery` 读取如今是 TUI 中唯一的会话发现途径。
- 启动器为其自身的应用铸造会话 id，因此一个不提供任何槽位的非 CLI 宿主，仍保留 bundle 自带的铸造逻辑。

## Testing

`packages/ui/tui/tests/tui.spec.ts` 钉住打印出的行、槽位缺失时的静默，以及对恶意消息的转义净化；此前那两个退出抑制测试被替换，因为抑制正是本次改动移除的行为。`packages/examples/tui-demo/tests/tui-agent.spec.ts` 通过一个伪造的 `ctx.get`，为 resume、启动器铸造与无槽位三种情形驱动身份槽位。

承重的覆盖是 `examples/tui-agent/tests/tui-keyless-smoke.e2e.ts`，它在一个 PTY 中拉起真实的 `apps/cli/src/bin.ts`：一个测试断言退出行携带 `--config`，一个回归测试植入一份个人 `config.yaml` 来替换整块 `tui-agent` 配置块并断言该行仍会打印——把「overlay 不能丢掉 resume」编码为一条被执行的契约，而非一句注释。

在 tmux 中针对真实的个人 overlay 做过实测：该缺陷在未修改的 staging 上复现（所请求的 id 被忽略，banner 里是新的 id），而在本分支上同一份 overlay 会产出一行打印的退出行、一个能恢复上一轮次的 `--resume`，以及一个把该会话标记为 `current · live · persisted` 的 `/resume` 选择器。错误的 id 现在会明确报错。
