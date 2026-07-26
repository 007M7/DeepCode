# @deepseek-ai/dsh-tool-goal

[English](README.md) | 中文

[`ctx.goals`](../goal/README.md) 的面向模型控制接口：`get_goal`、`create_goal` 和 `update_goal`。[goal 工具 Agent Note](../../../.agents/notes/implemented/feature/2026-07-19-model-facing-goal-tools.md)负责权限拆分与 Codex 风格用户体验。

## 工具

- `get_goal()` 返回当前 goal 或 `null`，包括比较并设置 id／revision、持久 phase、已经准入／受限的 goal round、任何 blocker reason，以及当前进程本地激活状态。
- `create_goal(objective, max_goal_rounds?)` 从顶层用户直接轮次创建一个 goal。模型可以从长期 goal 意图中推断，而无需精确命令短语；非用户轮次和 subagent 会在执行时被拒绝。
- `update_goal(goal_id, revision, action, objective?, max_goal_rounds?, blocked_reason?)` 支持 `edit`、`pause`、`resume`、`complete` 和 `blocked`。替换值只属于 `edit`；`blocked_reason` 只有在 action 为 `blocked` 时才必填，并以稳定代码 `model-reported` 持久化。严格 schema 下的空字符串和零填充值视为省略，而有意义的值仍限定到各自 action。

所有调用都互斥，因此模型排序的批次能观察到更早变更及其新 revision。UI 客户端会收到纯通用卡片：`get_goal` 使用 read，变更使用 other。变更卡片选择第一个有意义的 action 值，否则显示 goal id，因此已接受的填充值绝不会产生空输入。

3 个规范值都与已经渲染给 Native 调用方的紧凑 JSON 一致：`{ goal: null }` 或 `{ goal: { id, revision, objective, phase, roundsStarted, maxGoalRounds, blockedReason? }, activation }`。因此，编程消费方无需解析渲染后的 JSON，即可收到相同领域结构。

自主 goal round 成功报告 `complete` 或 `blocked` 时，会为该物理轮次贡献现有终结 `agent/turn-stop` 决策。用户直接变更绝不会贡献该停止决策：assistant 可以确认变更，并发的用户 steering 仍可进入循环。

## 权限

执行要求完全相同的活跃 `exec.agent`、其继承的 `AgentRegistry` initiator、running 状态与开放轮次。create、edit、pause 和 resume 还要求运行时根 agent 的当前轮次中存在已接受的 `{ kind: 'user' }` 消息或 steering 事件。持久 fork 谱系不会降低已恢复根 agent 的等级；活跃 subagent 所有权会降低。

`{ kind: 'user' }` 是宿主证明。`Agent.followup()` 与 `steer()` 会在调用方省略 source 时分配该值，因此插件、调度器与其他非用户生产方必须传入自己的 source，不能继承用户权限。

complete 与 blocked 还接受完全相同的当前 goal round：来源为 goal 的 `user/message`，其 id、revision 和 round 与折叠后的当前 goal 相等。在达到 `blockedAfterConsecutiveRounds` 前，goal-round 的 blocked 调用会被机械拒绝；模型判断同一条件是否确实持续，并必须在 `blocked_reason` 中说明。用户直接权限可以立即停止 goal。

## 配置

```yaml
- id: tool-goal
  name: '@deepseek-ai/dsh-tool-goal'
  config:
    blockedAfterConsecutiveRounds: 3
```

该值必须是正安全整数。它既提供模型自行阻塞的硬下限，也决定模型指引中点名的数量。

## 模型体验

### 系统提示词

#### 模型看到的内容

固定 goal 策略说明何种用户语义意图值得创建 goal，要求更新前先精确读取 ref，解释会话 resume／fork 后如何重新激活，并限制完成／阻塞声明。配置的阈值会插入该指引。

##### Goal 策略

```markdown
Use goal tools for one long-running completion objective in the current session. create_goal may infer goal intent from a direct human request in any language; do not create a goal for routine single-turn work. Call get_goal before update_goal and copy its exact goal_id and revision. After session resume or fork, an active goal is disarmed: when a human asks to continue or resume in any wording or language, use update_goal action resume to rearm it. Mark complete only when the objective is actually achieved. Mark blocked only after the same blocking condition persists for at least 3 consecutive goal rounds, and report that concrete condition in blocked_reason; difficulty, uncertainty, or useful remaining work is not blocked.
```

#### Token 影响

此插件的提示词注册位于请求范围内时，每次请求都会产生少量固定输入成本。

#### KV Cache 影响

插件范围、配置阈值和指引文本不变时，前缀保持稳定。激活、资源释放或配置变更可能使此提示词章节的复用失效。

### 工具 schema 与结果

#### 模型看到的内容

生成的 [`get_goal`、`create_goal` 和 `update_goal` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-goal)。成功结果是紧凑 JSON。变更结果之后是工具批次结束后由 goal 领域产生的原始 `<goal_state>` 快照。结果中的 `activation` 是活跃观察值，绝不会成为回放权限依据。

#### Token 影响

固定 schema 成本，加上每次调用的一条紧凑结果。变更还会保留领域快照，直到压缩。

#### KV Cache 影响

Schema 的定义与可见性不变时，前缀保持稳定。调用、结果和生成的 goal 快照会追加到可复用请求前缀之后，不会使更早条目失效。

## 已知限制与暂缓工作

- **语义意图仍由模型判断**：执行只能证明直接用户来源，无法证明请求是否足够重大而值得创建 goal。
- **阻塞条件是否相同仍由模型判断**：运行时强制执行不同的已准入 round 计数，而不是障碍的语义等价性；独立评估器保持暂缓。
- **不负责调度或直接用户呈现**：这些工具只变更状态；同会话驱动器与 [`dsh-command-goal`](../command-goal/README.md) 是同一领域的独立消费方。
- **Goal-round 权限需要驱动器**：除非续行驱动器准入 goal 来源的用户轮次，否则自主 `complete`／`blocked` 路径不会启用；只挂载此工具包不会创建这些轮次。
- **提示词注册与过滤相互独立**：某个范围可能隐藏工具，却保留指引，除非部署将两项注册限定在同一范围。
