# RFC: harness 层 goal-based loop

Status: proposed

[English](2026-07-16-harness-level-loop.md) | 中文

## 问题

`packages/core/agent-loop` 只跑 inner loop：一次 turn 内推理加工具循环，模型返回 `end_turn` 就结束。其 README 明确写「No built-in turn budget」——预算是它自己承认的 gap。跨轮次调度落在 harness 层：跑到测试全绿、按 rubric 反复改稿、把 PRD 拆成 bead 逐个推进、无人值守跑一整晚。这几类任务今天都没有一等公民的实现。

现有代码里有三种「能凑合跑」的替代，都不够用：

| 替代 | 问题 |
|---|---|
| `packages/workflow` 脚本表达 `while (!done)` | README 明写「No token-budget vocabulary」和「No journaling or resume」；父 turn 阻塞到脚本 settle。能跑几分钟的编排，跑不了几小时的长期任务 |
| 外部 shell `while :; do dsh …; done` | Ralph 风格的调度今天就能这么写。缺共享的 stop condition、budget、evaluator 词汇，每个使用者各自重发明；循环本身没有持久化对象可供事后诊断或恢复 |
| `packages/subagent` seam 的 `sendMessage`/`resume` | README 明写「Runtime steering and continuation are seam-only capabilities」。没有 model-facing consumer，模型只能起 fresh 子会话 |

典型使用场景有三类。**自动化修复**：面前一个失败的测试套件，希望一个进程持续修改代码、跑测试、根据失败信息再修改，直到全绿或触达预算上限。**按 rubric 迭代改稿**：一份文档、代码或翻译需要满足打分标准，循环反复调整、独立评估者打分、直到达标或耗尽轮数。**无人值守长跑**：例如通宵把一个仓库从一种技术栈移植到另一种，下班前启动第二天回来看结果，全程只有预算兜底。三类共同的形态：几分钟到几小时、evaluator 决定成败、预算是硬约束、跑完还需要能回看和恢复。

## 提案

**Loop 有四种触发形态**，按谁在什么时候启动一轮划分：

| 形态 | 谁触发 | 何时触发 | 现有对标 | 本 RFC |
|---|---|---|---|---|
| **turn-based** | 用户在会话里发一条消息 | 每一轮用户回复 | `packages/core/agent-loop` 现有一次 turn 内的推理与工具循环 | 不覆盖，已有实现 |
| **goal-based** | 用户或 agent 明确指定「跑到某条件为止」 | 一次启动，evaluator 判停 | Claude Code 的 `/goal`、Codex 的 `/goal`、Ralph 家族 | **本 RFC 覆盖** |
| **time-based** | scheduler | 按 cron 或时间间隔 | Claude Code 的 `/loop`（周期性）、`/schedule` | 延后到 `dsh-schedule` RFC |
| **proactive** | agent 自己 | agent 在推理中意识到需要开一个 loop 时 | Anthropic ClaudeDevs 4 类分类里的 proactive 档 | **本 RFC 自然包含**（agent 调 `loop` tool 就是 proactive） |

本 RFC 只**新增 capability seam `packages/loop/`** 处理 goal-based 一种。proactive 复用同一 `loop` tool，agent 主动调用即触发，无需额外机制。time-based 需要独立的 scheduler package，属于另一份 RFC 的事情；本 RFC 只在 cordis leaf 触发面预留跟未来 `dsh-schedule` 联动的钩子。

三个包：

- `@deepseek-ai/dsh-loop`：类型、`LoopDriver` service、`StopCondition` 判别联合、四个内置 service 定义（`Evaluator` / `BudgetPolicy` / `RoundHandoff` / `GoalReflector`）、事件 schema
- `@deepseek-ai/dsh-loop-driver`：默认 driver 实现
- `@deepseek-ai/dsh-loop-tool`：model-facing `loop` tool + CLI `dsh loop`

设计围绕四个具体问题展开，每个问题对应一条独立的 cordis service seam：

1. 长跑 loop 出问题后缺诊断和恢复手段。**loop 作为独立 session** 解决。
2. loop 结束时的 PASS 是否可信决定几小时工作是否作废。同一个 LLM 既生成又自评的架构本身就不可信。**Evaluator 与 Budget 做成 service seam** 解决。
3. 短任务和长任务需要的记忆策略相反，硬编一种模式会让另一类场景不可用。**RoundHandoff 做成 service seam** 解决。
4. 用户初始给的 goal 未必始终正确。agent 沿着错的目标蛮干会耗尽预算做错事。**GoalReflector 做成 service seam** 解决。

四条 seam 之外还有一条贯穿全文的原则：**一个 loop 只处理一个原子目标**。大目标拆成若干小 loop 串联，不塞进一个 loop 让 evaluator 判定多件事。判定 granularity 是否合适的经验规则：如果 loop 跑完说不清它到底做完了什么，granularity 就太大，应当拆。Phase 2 补 `loop_split` model-facing tool 让 agent 收到过大 goal 时能自己拆。

术语约定：**inner loop** 指 `packages/core/agent-loop` 一次 turn 的推理与工具循环；**harness loop** 指本 RFC 引入的外层调度器，围绕 inner loop 反复迭代。本 RFC 不改 `agent-loop`，符合 AGENTS.md「Plugins, not loop changes」。

`StopCondition` 是 discriminated union，`assertNever` 收口：

```ts
interface EvaluatorReport { criteria: readonly { name: string; pass: boolean; evidence: readonly string[] }[] }

type StopCondition =
  | { kind: 'goal-met'; evidence: EvaluatorReport }
  | { kind: 'budget-cap'; scope: 'usd' | 'tokens' | 'rounds' }
  | { kind: 'stuck'; pattern: 'repeat-action' | 'no-progress' | 'error-loop' }
  | { kind: 'approval-required'; reason: string }
  | { kind: 'user-cancel' }

export {}
```

### Loop 作为独立 session

长跑 loop 一旦出错，用户没有系统的诊断手段。跑几小时后失败，只能翻散落的日志文件。发现中间某一轮走偏想倒回去重跑，只能从头开始。agent 想参考自己过去 loop 的经验也没有可用的 API。

Driver 为每个 loop 开一个独立的 loop-session（新的 session id）。每轮的输入、inner-loop 结果、evaluator 报告、stop 决策都作为 session event 落盘，复用 `packages/session-persistence` 的 SQLite backend。得到三种能力。

- **从任意轮恢复**：发现第 78 轮偏航，从第 77 轮拉起，换 prompt 或换 evaluator 重跑，不必从头
- **事后诊断**：通过 [sqlite-session-query-provider](2026-07-10-sqlite-session-query-provider.md) 查「哪一轮 evaluator 开始一直挂在同条 criterion 上」定位卡点
- **元循环学习**：agent 开新 loop 前查自己过往同类 loop 的经验——「我以前 fix 过类似的 bug 吗？失败在哪一轮？」

Claude Code、Codex 的 `/goal` 是一次性对象：跑完就丢，agent 下次遇到同类问题从零开始。

**存储与依赖**。每轮几 KB events，100 轮 loop 约 100–500 KB；跑几千个 loop 会到 GB 级。`logDetail: 'summary' | 'full'` 配置缓解，默认 `full`，长跑用户可切 `summary`。中间态全持久化会把生成过的 key、密码一并落盘，跟普通 session 是同一类风险但量放大 10–100 倍，README 明确提示。**最关键的一条**：本节能力硬依赖尚未落地的 [sqlite-session-query-provider RFC](2026-07-10-sqlite-session-query-provider.md)。若该 RFC 未落地，任意轮 resume 与查询能力会降级为「只能翻 JSONL 文件」。若 Phase 1 交付时该 RFC 还未 merge，本 Phase 只保证 event 结构正确，query 面延后到 Phase 2。

### 可插拔的 Evaluator 与 Budget

loop 的价值最终取决于结束时的 PASS 是否可信。如果 evaluator 会被 hack 或幻觉 PASS，前面几小时的工作全部作废。同一个 LLM 既生成又自评的架构本身就不可信：模型有条件说服自己 PASS。即便让独立 subagent 做 evaluator，只要 evaluator 还是 LLM，就仍然对同类内容有系统性偏好——独立 subagent 只是缓解不是根治。

真正可信的评估必须是完全非 LLM 的硬检查：shell exit code、静态分析、外部服务。LLM 物理上碰不到评估过程。但硬检查只有用户自己知道该跑什么：不同项目 `pytest` 命令不同、公司有私有合规检查器、有些团队还要跑内部 lint。主库无论内置几种都覆盖不全。所以 evaluator 必须做成用户可以自己接入的 seam。

预算方面同理：产品级的花费护栏是黑盒，无法按团队策略调整（个人卡、团队分摊、按 PR 结算）。

`Evaluator` 和 `BudgetPolicy` 都作为 cordis service seam 暴露。`Goal` 必须携带一个明确档位的 `EvaluatorSpec`，driver 拒绝启动没有 evaluator 配对的 loop——含糊的目标（"把代码写好"）不能进入 loop 系统：

```ts
interface RubricItem { name: string; description: string }
interface EvaluatorContract { readonly name: string }

type EvaluatorSpec = {
  tier:
    | { kind: 'single-metric'; check: string }              // "pytest -q && ruff check"、"exit code == 0"
    | { kind: 'rubric'; criteria: RubricItem[] }             // 若干独立 criterion，各自 pass/fail + evidence
    | { kind: 'contract'; interface: EvaluatorContract }     // 结构化合约（如 API sig 校验）
    | { kind: 'llm-judge'; rubric: string; model: string }   // 兜底档，仅软目标
  /**
   * 主 agent 不可写的路径（通常是 evaluator 会读的测试文件、评估配置）。
   * 违规写会被 packages/fs policy gate 拒绝，记 loop/hack-attempt session event。
   * 这是防 reward hacking 的核心机制——把「改测试让 evaluator 通过」这条路封死。
   */
  protectedPaths?: readonly string[]
}

export {}
```

**为什么分档，而不是让用户传自由函数？** 档位强制用户在启动时明确「用哪一档强度判成败」。自由函数看起来灵活，实际让 evaluator 强度隐性下沉——用户以为在做严格判定，实际写的是 LLM-judge 那种模糊的语义匹配。长跑场景下代价是几小时白跑。

四档从上到下可信度依次降低。前三档都是完全非 LLM 的硬检查。`llm-judge` 是最弱一档，仅用于确实无硬信号的软目标（改稿、翻译质量）。文档明确标注「此档不能挡定向对抗，长跑无人值守场景需至少一档硬检查配合」。

Driver 强制五条硬约束，不下放给 Evaluator 实现。它们分别对付三类不同的攻击面：

**防「同一个 agent 既生成又自评」**：

1. **fresh subagent**：evaluator 每轮开 fresh subagent（用 `dsh-subagent` 的 `spawn`），不继承主循环 context

**防主 agent 通过修改 evaluator 输入来 reward hack**：

2. **`protectedPaths` 硬隔离**：`EvaluatorSpec` 声明的路径（通常是测试文件、评估配置）由 `packages/fs` 已有的 policy gate 拒绝主 agent 的写请求，记 `loop/hack-attempt` session event。这是 Phase 1 真正挡 reward hacking 的一层——直接封死「改测试让 evaluator 通过」这条路

**防 evaluator subagent 自身被 subverted**：

3. **只读工具集**：evaluator 的 tool set 被 driver 剥离到只保留读类工具，写类工具禁用（复用 `SubagentProvider` 的 `toolFilter`）。它防的不是主 agent 的 reward hacking，而是 evaluator 读到被 evaluate 的代码里 embed 的 prompt injection 时不会被诱导去改状态

**防 evaluator 报告本身欺骗 driver**：

4. **PASS 只能由 evaluator 报告翻转**：`goal-met` StopCondition 只能来自 evaluator，driver 或主 agent 都不能直接构造
5. **Default-FAIL**：driver 内部维护每个 criterion 的 pass 状态默认 `false`，只有 evaluator 报告里带非空 evidence 才允许翻 `true`；evaluator 无法通过返回 `{pass: true}` 而不给 evidence 让 driver 接受

五条一起决定 evaluator 结论只能靠证据推动，无法靠自信推动，也无法靠主 agent 悄悄改测试推动。

**Phase 1 内置三个 backend**：

- `loop-evaluator-shell` 实现 `single-metric`：跑 shell 命令，`exit 0` = pass
- `loop-evaluator-rubric-judge` 实现 `llm-judge`：预写 rubric + LLM 打分，仅软目标
- `loop-budget-preflight`：每轮启动前估 `(promptTokens + overhead + estOutputTokens) / 1M × pricePerMTok`，超 `perRoundUsd` 拒绝启动。估算模型来自 MartinLoop `policy.ts:551-596`

`PricingProvider` 服务注入 pricing 表，test seam 可覆盖，不硬编到 driver 里（AGENTS.md「No hardcoded tunables in plugins」）。`rubric` 与 `contract` 档 Phase 2 补内置实现，Phase 1 只暴露类型让第三方插件先接。

**局限**：evaluator subagent 拿到的"只读工具"仍是同一进程的 shell 与 fs 读，理论上仍可能被 prompt injection 绕过。挡定向对抗需要两容器方案（evaluator 定义文件对主 agent 完全不可访问，Anthropic patch.py 走的就是这条路），本 RFC Phase 3 才做。见 风险。

### 可插拔的 RoundHandoff

每轮之间如何传递 context 是一个两难。完整保留之前对话（continue）连续性好，但对话会持续增长最终撞上 context 上限，且上一轮的错误信息会污染后续每一轮。每轮从零开始（fresh）避免污染，但每次需要重新理解上下文。跑 3 轮改稿与跑 80 轮 overnight 修 bug 需要的策略是相反的。Claude Code、Codex 都硬编一种模式，用户没法按任务类型切换。

做成 service seam：

```ts
interface RoundContext { loopId: string; round: number }
interface NextRoundSpec { mode: 'fresh' | 'continue' }

interface RoundHandoff {
  buildNextRound(prev: RoundContext): NextRoundSpec
}

export {}
```

Phase 1 内置三个 backend：

| Backend | 场景 | 机制 |
|---|---|---|
| `handoff-fresh-with-summary`（默认） | 长跑、无人值守 | 每轮开 fresh subagent，只注入一段 progress 摘要作 system prompt 附加段 |
| `handoff-continue-with-compaction`（推荐中间档） | 5–20 轮的中等长度 | 整段对话保留到 token 阈值，超了复用 [`packages/compact`](../../../../packages/compact/README.md) 压缩，摘要 + 最近 K 轮作起点 |
| `handoff-continue-raw`（专业档） | ≤5 轮短任务、测试 | 纯连续对话不裁剪 |

**为什么默认 fresh？** 所有实际跑成的长跑 loop（repomirror、Kimi ralph-loop、autoresearch）用的都是 fresh。把重要 loop 状态放在 context window 外由 driver 管理是长跑的正确姿势。`handoff-continue-raw` 违反这条经验，README 明写长跑不适用。

**为什么中间档只有我们能做？** `handoff-continue-with-compaction` 依赖 compaction seam——竞品都没有，只有本仓库 `packages/compact` 提供了这个基础设施。

**为什么做成 seam 而不是三选一 flag？** 用户可以写 20 行插件表达「前 5 轮 continue、之后 fresh」这类混合策略，或表达「context 到 50% 自动 compact 一次」，不用等主库支持。

**局限**：`continue-with-compaction` 依赖 `packages/compact` 的压缩质量，压缩本身可能把幻觉信息写进摘要传下去；README 建议长跑首选 fresh。三个 backend 的边界会让新用户不知道选哪个；`dsh loop` CLI 默认用 fresh，用户在遇到具体问题前不需要理解这些差别。

### 可插拔的 GoalReflector

用户在启动 loop 时给的目标不一定准确。可能基于错误假设（让 agent 用某个已经废弃的 API 实现功能），可能不够清晰（agent 在做的过程中才发现需要澄清），也可能被后来的信息证伪。现在的循环执行框架把 goal 当作启动时冻结的合约，agent 只能沿着原路蛮干，结果是在错的方向上耗尽预算。

做成 service seam，与 `Evaluator` 职责分离：evaluator 问「是否达成目标」，reflector 问「目标是否还是那个目标」。

```ts
interface RoundContext { loopId: string; round: number }
interface GoalConcern { concern: string; severity: 'low' | 'medium' | 'high' }

interface GoalReflector {
  reflect(ctx: RoundContext, concerns: GoalConcern[]): Promise<GoalReflection>
}

type GoalReflection =
  | { kind: 'continue' }                              // goal 仍有效
  | { kind: 'revise'; newGoal: string; why: string }  // 建议修正 goal
  | { kind: 'stop-for-human'; reason: string }        // 需要人拍板

export {}
```

**concern 有三种触发来源**，Phase 1 实现前两种：

- **agent 主动**：通过 model-facing tool `loop_flag_concern({ concern, severity })`。agent 在调研中意识到「用户假设的那个库已经废弃」时可以直接 raise
- **driver 启发式**：预算过 50% 且零 criterion pass 时，driver 自动 raise `no-progress-toward-goal` concern
- **周期性 reflector subagent**（Phase 2）：每 N 轮独立跑一个只读 subagent 复审 goal 有效性，与 evaluator 独立性遵循同一思路

**响应策略通过 `onGoalConcern` 配置项**。这四种配置对应不同的 loop 使用哲学，用户按团队协作方式选，driver 不预设立场：

- `'stop'`（Phase 1 默认）：任何 concern 都触发 `StopCondition: approval-required`，人拍板。loop 在遇到任何不确定性时都不应自己往下走，适合谨慎风格团队与影响面较大的 loop 场景
- `'notify-continue'`（Phase 1）：记 `loop/goal-concern` session event（高优先级）加 ACP 显式提示，继续跑，人在结束时集中审阅。loop 内部不打扰，适合无人值守长跑
- `'reflect'`（Phase 2）：调 `GoalReflector` 决定 continue、revise 还是 stop。委派一个独立 agent 代替人做初步判断，适合中等自主度的团队
- 不注册 `GoalReflector` 且 `onGoalConcern` 未设 = 最放手档，loop 只在传统 stop condition 触发时停

**为什么默认选 `stop`？** 无人值守场景下宁可多停一次也不要在错方向上跑几小时。用户明确要无人值守可切 `notify-continue`。

concern 本身就是普通 session event，跟前文的持久化 session 能力天然协同：resume 时可以从 concern 出现的那一轮拉起，换 goal 重跑，前 N 轮的工作不丢。

**滥用与丢失防护**。agent 可能每轮都 raise concern；缓解是 `severity` 字段和 driver 侧的最小 rate limit（同一 concern 30 秒内去重）。这种滥用的代价是 agent 卡住自己无法推进，动机不强。goal 被 revise 后原始 goal 会丢失；每次 revise 落 `loop/goal-revised` session event 带 rationale，resume 时可选任意历史 goal 版本。

### 用户面

四个触发面共享同一个 driver：

- **agent 侧 tool**：`loop({ goal, evaluator, maxRounds, maxUsd, onGoalConcern })` 启动嵌套 harness loop。正在跑的 loop 内部 agent 可用 `loop_flag_concern({ concern, severity })` 主动发起 concern。ACP 渲染意图为 `generic`。agent 自主发起就是 proactive 触发，无需额外机制
- **CLI**：`dsh loop <prompt> --stop <shell-cmd> --max-rounds N --max-usd X --handoff fresh`。人类主导启动，最典型的 Ralph 风格用法
- **cordis leaf**：`cordis.yml` 里以 leaf 形式声明常驻循环，配合未来的 `dsh-schedule` RFC 可做周期性触发
- **ACP slash command**：`/loop <goal>`（还有 `/loop-flag-concern`）在编辑器/客户端的当前会话里直接启动。语义等价于人类在 CLI 里敲 `dsh loop`，但发生在正在进行的 ACP session 上下文中，允许 loop 结果直接注入会话

ACP slash command 的依赖：`packages/ui/acp` 的 `available_commands_update` 面目前是 unbuilt 状态（[acp-feature-support.md](../../../../packages/ui/acp/acp-feature-support.md)）。等 harness 的 slash command 基础设施落地，`/loop` 与 `/loop-flag-concern` 只需在该基础设施里注册；driver 与 tool 接口不变。本 RFC 保留名字并给出参数 shape，但不承诺基础设施本身——那属于独立的 ACP 补齐 RFC。

默认 system prompt 里有两条硬约束，随所有内置 `loop` tool 一起分发：

1. 不允许写 `TODO`、`FAKE`、`PLACEHOLDER` 占位符让 evaluator 表面通过
2. 不允许写空的 `try/except` 或 `catch(_)` 让 evaluator 忽略错误

这两条不是 seam 层能拦的，是 prompt 层的约定。用户可以自定义 system prompt 但内置约束保留。

### 与仓库现有代码的关系

直接复用无需修改：

- `packages/subagent` 的 `spawn` provider、`toolFilter`、`persona`——loop 每轮起 subagent、evaluator 只读工具集
- `packages/session-persistence` 的 SQLite backend——loop-session 落盘
- `packages/compact`——`handoff-continue-with-compaction` 的实现基础
- `packages/todo`——单会话 continue 模式下作为可选 progress 表达
- 若 [ToolExecution.reportProgress](2026-07-13-stream-workflow-progress-through-tool-calls.md) 先落地，loop tool 可用它逐轮 UI 更新

不动：`packages/core/agent-loop`（inner loop 语义保持）；`packages/workflow`（DAG 编排 vs. 迭代同 goal 是 orthogonal 关系，两个 README 在「Related」段互链说明边界）。

依赖尚未落地的两处：

- [sqlite-session-query-provider](2026-07-10-sqlite-session-query-provider.md)——见 Loop 作为独立 session 局限段的缓解方案
- ACP slash command 基础设施（`available_commands_update` 面）——见 用户面。基础设施落地前，slash command 触发面缺席，其它三个触发面照常工作

唯一涉及现有代码的改动可延后到 Phase 2：给 `packages/subagent-tool` 增加「续跑已有 subagent」的参数暴露，用于 `handoff-continue-*` 两个 backend。底层 `SubagentRun.sendMessage` 与 `resume` 已作为 seam 能力存在，缺的只是 tool 层的参数入口。若 Phase 1 只上 `handoff-fresh-with-summary`，完全不动 subagent-tool；Phase 2 再补。

### 分阶段

**Phase 1**（本 RFC 承诺范围）：三包 seam；`StopCondition`；`EvaluatorSpec` 四档类型 + `protectedPaths` 硬隔离（复用 `packages/fs` policy gate），其中 `single-metric` 与 `llm-judge` 有内置实现，`rubric` 与 `contract` 类型开放待接；Default-FAIL 强制；3 个内置 evaluator/budget/handoff backend；`loop_flag_concern` tool；no-progress 启发式；`onGoalConcern: 'stop' | 'notify-continue'` 二档；CLI；tool；默认 system prompt 硬约束。**不含**：session-query 面、ACP slash command 触发面（依赖 `available_commands_update` 基础设施）、subagent-tool 续跑改动、stuck 检测器、Reflector subagent、`loop_split` tool、`rubric` 与 `contract` 档的内置实现。

**Phase 2**：query 面；stuck 检测器（复现 OpenHands 5 种模式）；subagent-tool 续跑改动（解锁 continue 两档 handoff）；Reflector subagent；`onGoalConcern: 'reflect'` 档；`loop_split` model-facing tool；`rubric` 与 `contract` 档的内置实现。

**Phase 3**：agent fleet（同 goal 派 N 个并行 loop 取最优）；与 `dsh-schedule` 集成；两容器 evaluator 隔离（evaluator 定义文件对主 agent 完全不可访问，防 reward 反向优化）。

## 备选方案

**扩 `packages/core/agent-loop`**：给 inner loop 加「iterate on end_turn until goal」开关。拒绝——AGENTS.md「新行为走文档化扩展 seam；改 agent-loop 需要更新 docs/architecture.md」。harness loop 需要跨 session、跨 agent 的状态，塞进 inner loop 会把 session 语义拧成两层混合。

**只做一个 slash command `/loop`（Claude Code 复刻）**：实现最简。拒绝——slash-command 层不解决 harness/inner 边界；四条设计要点（可查询 session、分档 evaluator、可插拔 handoff、可插拔 goal reflector）在 slash-command 层没有承载点，本 RFC 承诺的能力全部丢失。

**全权外包给 `packages/workflow`**：把 loop 表达成带回边的 workflow 节点。拒绝——workflow 缺 iteration、StopCondition、Evaluator 的一等公民语义。硬用会把 evaluator 冒充成一个 phase，违反 evaluator 独立于 producer 的架构隔离要求；预算护栏在 workflow 是 phase-level 而非 round-level，粒度对不上。

**A（fresh）vs. B（continue）硬编二选一**：Ralph 派和 LoopTroop 派各自都有强场景。拒绝——可插拔的 RoundHandoff 提出 seam + 三档内置 backend 涵盖两派并允许 hybrid。

**不做 evaluator seam，内置几种够用**：更轻。拒绝——可插拔的 Evaluator 与 Budget 的核心价值是团队或私有 evaluator 可扩展。写死后长跑无人值守场景的用户只能改主库。

**接受不带 `EvaluatorSpec` 档位的自由函数**：允许用户传任意 `(result) => boolean`。拒绝——档位强制用户在启动时明确「用哪一档强度判成败」，是防止不知不觉滑到弱档的关键。自由函数看起来灵活，实际让 evaluator 强度隐性下沉，长跑场景代价大。

**引入独立记忆引擎（Beads / dex-style）**：外部化状态的成熟做法。拒绝——`packages/session-persistence` + `sqlite-session-query-provider` 已能提供等效能力；新引擎收益远小于维护成本。

**goal reflection 塞进 Evaluator seam**（让 evaluator 返回「criteria 不可能满足」）：拒绝——混淆「是否成功」和「目标是否正确」两个正交问题。`Evaluator` 应保持独立、只读、简单。

**goal-concern 只做 event 不做 seam**：更轻。拒绝——响应策略族（stop / notify / reflect）明确，各团队会想插自己的，seam 化投资小于收益。

**Phase 1 就上完整 Reflector subagent**：更全。拒绝——`loop_flag_concern` tool + no-progress 启发式 + 二档 policy 覆盖 80% 场景；每轮跑独立 subagent 成本高，Phase 2 按需引入更合理。

**不做 `loop_split`，用户自己拆**：Phase 1 已经如此。Phase 2 加是因为长跑场景发现 agent 收到过大 goal 会直接跑而不是自己拆，需要显式工具引导。

## 验收标准

- `packages/loop/{loop,loop-driver,loop-tool}` 三包按 capability seam 建成；`dsh-loop` 只导 types 与 registry
- `StopCondition` 判别覆盖所有分支（单元），`assertNever` 编译期收口
- `Evaluator`、`BudgetPolicy`、`RoundHandoff`、`GoalReflector` 四条 service 都能被外部插件替换（fixture：注入 mock 实现，driver 正确调用）
- `EvaluatorSpec` 四档类型编译期收敛；driver 拒绝启动没有 evaluator 配对的 loop（fixture：`loop({ goal, evaluator: undefined })` 立即返回配置错误）
- Default-FAIL fixture：evaluator 报告返回 `{criterion, pass: true, evidence: []}` 时 driver 拒绝该 criterion 翻转、记 `evaluator/invalid-report` session event
- 三个内置 handoff backend 都有单元 + 一个 e2e：`fresh-with-summary`（跑到 pass）、`continue-with-compaction`（跑超 token 阈值触发 compact）、`continue-raw`（跑 3 轮）
- `dsh loop` CLI e2e：给定 goal + 3 轮上限 + 一个 shell evaluator，通过与耗尽两条路径都返回结构化 stop cause 并 exit code 语义化
- Evaluator 独立性 fixture：主 agent 有 fs.write，evaluator subagent 的 tool set 里没有；试图调 fs.write 被 registry 拒绝
- protectedPaths fixture：`EvaluatorSpec.protectedPaths: ["tests/**"]` 声明后，主 agent 尝试写 `tests/foo.py` 被 `packages/fs` policy gate 拒绝并记 `loop/hack-attempt` session event，evaluator 侧读该路径正常
- Preflight 护栏 fixture：注入 mock pricing 表构造超 `perRoundUsd` 的场景，driver 拒绝启动该轮且 emit `budget-cap` StopCondition
- Goal concern fixture：`loop_flag_concern` 可从主 agent 调用并产出 `loop/goal-concern` session event；`onGoalConcern: 'stop'` 下 emit `approval-required` StopCondition；`'notify-continue'` 下继续跑且事件带 ACP 高优先级标记；no-progress 启发式在预算超 50% 且零 pass 时自动触发一次（rate-limit 去重）
- 默认 system prompt 硬约束（无 TODO/FAKE/PLACEHOLDER、无空 catch）随内置 `loop` tool 一起分发，snapshot 覆盖 prompt 内容
- 每轮的 prompt、inner-loop 结果、evaluator report、stop 决策都以 session event 出现；Phase 2 补 query 面时可按 `loopId` 检索
- `packages/loop/README.md` 和 `packages/workflow/README.md` 的「Related」段互链清楚「何时用 workflow、何时用 loop」的边界
- 单元 100% / snapshot / e2e / doc-sync / verify-module-graph / build / hygiene 全绿；新增 tool 的 ACP 渲染意图（`generic`）有 snapshot

## 风险

**依赖 [sqlite-session-query-provider](2026-07-10-sqlite-session-query-provider.md) 落地**。Loop 作为独立 session 的用户可见价值（任意轮 resume + 元循环学习）需要它。缓解在该节局限段；Phase 1 不硬绑，Phase 2 才交付 query 面。

**`packages/workflow` 与 loop 的边界是持续答疑热点**。「多轮是 loop 还是 workflow」两个 README 必须写清楚：workflow 是「步骤已知、agent 未定、并串行编排」；loop 是「agent 已定、轮数未定、evaluator 判停」。文档不清晰会让用户混用错档。

**evaluator 反向优化（reward hacking）**。足够长的 loop 里 agent 有条件识别 evaluator 的模式并针对性优化，例如发现「只要测试文件里出现 `assert True` 就 PASS」从而绕过实质完成。**Phase 1 靠 `protectedPaths` 挡多数 case**：evaluator 的输入文件（测试、评估配置）通过 `packages/fs` policy gate 声明为主 agent 不可写，直接从「改测试让 evaluator 通过」这条路上封死。但仍无法阻止 agent 学出 evaluator 的模式做实质规避（比如写符合表面 pattern 但语义错的代码）。对抗强度高的用户需要 Phase 3 的两容器方案：evaluator 的整个运行时（二进制、rubric、依赖库）都在主 agent 完全不可访问的容器里，Anthropic patch.py 走的就是这条路。

**占位符伪造与过度防御码**。agent 有时会写 `# TODO: implement` 让测试勉强通过，或写大量 `try/except: pass` 让 evaluator 表面 PASS。这些不属于 evaluator 层的问题，而是 agent 生成阶段的 prompt 与训练问题。缓解走 用户面 段那两条默认 system prompt 硬约束；用户自定义 evaluator 时若加入「静态检查禁止 TODO 与空 catch」这类规则更稳妥。这类问题不是 seam 层能根治的。

**预算估算漂移**。pricing 表是常量，模型调价后估算会飘。护栏保守方向的近似不算 bug，但 README 说明「真实计费以 usage 事件为准，preflight 仅保护单轮爆炸」。

**长跑 loop 日志膨胀**。跑 100 轮 loop 单 session 上 MB 级。`logDetail: 'summary'` 兜底但 Phase 1 默认 `full`，Phase 2 再补 summary 语义。

**pre-release 允许直接演进**。`SESSION_FORMAT_VERSION=0`，`LoopRoundEvent` schema 可随时改；后端拒收旧格式而非兼容，与 AGENTS.md 顶部 pre-release stance 一致。
