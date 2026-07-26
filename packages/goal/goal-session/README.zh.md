# @deepseek-ai/dsh-goal-session

[English](README.md) | 中文

[`ctx.goals`](../goal/README.md) 的同会话续行驱动器。它通过公开 `Agent` 与会话 seam，把活跃且已激活的目标转换为连续的 [goal round](../../../docs/glossary.md#goal-round)；[同会话驱动器 Agent Note](../../../.agents/notes/implemented/feature/2026-07-19-same-session-goal-round-driver.md)负责竞态和生命周期理由。

## 组合

```yaml
- id: goal
  name: '@deepseek-ai/dsh-goal'

- id: tool-goal
  name: '@deepseek-ai/dsh-tool-goal'

- id: goal-session
  name: '@deepseek-ai/dsh-goal-session'
```

该插件没有可调配置。`maxGoalRounds` 属于目标定义，面向模型的阻塞阈值则属于 [`dsh-tool-goal`](../tool-goal/README.md)；在驱动器中重复任一数值都可能产生分歧策略。

## Round 契约

当完全相同的活跃 agent 处于 idle 状态，且目标 active、已经激活并有剩余容量时，驱动器先为待处理 goal 变更创建检查点，再预留 `roundsStarted + 1`，对应当前 `{ goalId, revision }`。它会排入一条 `<goal_round>` 提示词，并携带 `GoalMessageSource`。通过 `agent/prompt-submit` 准入时，会在下游提示词 hook 前后同时验证完整的排队记录与当前 goal；只有被接受的 `user/message` 才会增加 `roundsStarted`。因陈旧而被拒绝的预留不会消耗 round 编号。

一个 goal round 拥有一个普通会话轮次，该轮次可以包含多个模型／工具步骤。驱动器只会把预留与 `message` 轮次配对，且该轮次必须携带完全相同的 `GoalMessageSource`；可通过声明合并扩展的插件轮次触发器不会准入或替换该预留。用户消息仍是普通轮次，不消耗 goal 上限。如果用户工作在预留前进入 inbox，或加入预留的待处理批次，自动工作会让行，直到用户工作结算；混合批次中的待处理自动提示词会被拒绝，只有 agent 再次 idle 后才重新预留。

保留的提示词会点明经过 JSON 引用的目标与 `round/maxGoalRounds`，将当前工作区、工具结果和持久会话状态视为权威信息，要求在完成前提供证据，并要求在工作仍未完成时保持目标 active。引用可将多行或形似标签的目标文本保留为数据。goal 生命周期变更仍必须通过 `dsh-tool-goal` 的独立权限检查。

## 结算策略

| 持久轮次结果 | Goal 操作 | 自动重试 |
|---|---|---|
| goal 仍 active 且已激活时的 `completed` | 准入下一 round；达到上限时以代码 `round-limit` 阻塞 | 是 |
| 已预留／准入 goal round 的取消，或其 `aborted` 结果 | `paused` | 否 |
| 未尝试 goal round 时取消 | 保留持久 phase；撤销激活 | 否 |
| `error` 且带 `RATE_LIMIT` 或 `QUOTA` | 设为 `blocked`，代码为 `usage-limited` | 否 |
| 其他 `error`、`max-tokens` 或非陈旧提示词拒绝 | 以诊断代码和消息设为 `blocked` | 否 |
| 持久性失败、资源释放、中断或未知未来结果 | 撤销激活或阻塞，以便检查 | 否 |

某个 goal 在自身 round 中发生的变更，会取代旧 revision 的结算。因此，即使物理轮次随后关闭，完成、暂停、阻塞和编辑仍具有最终决定权。任何异常结果都不会自动重试。

## 生命周期与持久性

`goal/changed` 会产生持久性义务。排队工作前，驱动器会等待 `ctx.sessions.flush()`，并在等待后重新检查 goal revision 与竞争输入。关闭时的 flush 失败通过 `agent/error` 到达；即使后续一次性注入已经追加另一轮次，驱动器仍会把失败关联到完全相同的已关闭轮次，然后撤销激活，避免另一 round 启动。

此插件加载到现有 agent 上时绝不会继承激活状态。`GoalService.disarm()` 会移除进程本地权限，而不改变持久 phase、revision 或历史；之后由用户明确授权的 resume 会记录重新激活。会话 resume 和 fork 后，goal 领域通过 `agent/session-start` 处理应用相同规则。

取消采用先观察、后行动的顺序：具体循环会在清空队列或中止轮次前，发送带类型 cause 的 `agent/cancel-requested`。只有取消操作拥有已预留或已准入的 goal 尝试时，插件才会持久暂停 active goal；取消无关用户工作只会撤销进程本地续行权限。如果 pause 变更失败，驱动器会回退到撤销激活。插件 teardown 会关闭准入，撤销所有活跃 goal 的激活，以 `parent` cause 取消已经准入的 round，并在事件隔离仍安装的情况下等待驱动器和 agent 完全停稳。

## 模型体验

### Goal-round 提示词

#### 模型看到的内容

每个已准入 round 都是一段保留的用户角色 `<goal_round>` 块，其中点明完整目标与正 round 编号。更早的用户消息、goal 状态快照、assistant 输出与工具记录仍保留在同一会话历史中。

#### Token 影响

每个已准入 round 会增加一个固定指令块和目标。后续请求会重新发送保留的 round，直到压缩将其遮蔽；不会创建新 agent，也不会复制对话前缀。

#### KV Cache 影响

在一个 epoch 内仅追加：每个已准入 round 都会在可复用前缀后扩展现有对话。压缩可能替换派生历史后缀，并移动可复用边界。

## 已知限制与暂缓工作

- **没有独立评估器**：面向模型的 goal 策略会判断证据是否足以完成，以及 blocker 在语义上是否未变；评估器支持的认证仍保持暂缓。
- **只在同一会话执行**：此包有意不 spawn 新 agent、不 fork 会话前缀，也不实现 Ralph 风格的独立尝试；该工作流属于自己的插件层。
- **已接受队列的卸载竞态**：Cordis 插件卸载是异步的。已经被 agent inbox 接受的 goal 提示词可以在卸载开始前启动并消耗其 round；teardown 随后会取消请求、撤销 goal 激活并等待完全停稳。不会再启动后续 round。
- **只有 round 上限，不是资源预算**：token、货币、时间与提供方配额策略保持独立；观察到 `RATE_LIMIT` 和 `QUOTA` 时，只会映射为阻塞原因代码 `usage-limited`。
- **异常情况不自动重试**：短暂的提供方与持久化失败需要之后由用户授权 resume，而不是隐式重试策略。
