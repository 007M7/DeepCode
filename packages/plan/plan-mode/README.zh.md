# @deepseek-ai/dsh-plan-mode

[English](README.md) | 中文

按 agent（智能体）分开记录到日志的 plan 协作状态，提供部署拥有的引导内容、直接 `/plan [message]` 进入命令、`/plan off` 退出命令，以及经评审的 `exit_plan_mode` 退出。Plan mode 是软引导；沙箱模式和批准策略仍是独立的强制执行轴。

## 持久状态

`plan/mode`（`{ active: boolean }`）是一个仅写日志、整值替换的 `SessionEventMap` 成员。`foldPlanMode(events)` 返回最后记录的值，如果没有则返回 `false`，因此恢复、fork 和压缩（compaction）都能直接从会话日志恢复 plan 状态。UI 通过 `session/event` 观察已提交的切换。

`ctx.planMode.set(agent, active)` 在 agent 空闲时立即提交——下一个 prompt 之前不会有任何边界到来，因此独立的 `plan/mode` 事件当场落账——在 agent 运行中则持有待生效选择、等下一个轮内请求边界；返回值说明发生了哪种（`committed`/`queued`）、一次 `cancelled` 反转或 `noop`。`get(agent)` 返回 `{ active, pending? }`，将塑造当前步骤的日志状态与用户的轮中选择分开。提示词提交、常规续行和请求恢复重试都在覆盖范围内；当最后记录的请求头描述了另一状态时，用户选择的变更会贡献一条插件来源的 `user/message` 通知（两条提交路径皆然）。

## 模型与人类界面

激活时，`plan:policy` 会渲染已配置的 `section`。插件始终注册 `exit_plan_mode`，使工具 schema 在转换期间保持稳定；其 execute 路径只接受已激活的 plan mode，且只有通过 `ctx.userInteraction` 获得精确用户批准后才退出。

评审问题声明 `plan-review` 呈现意图，并指名 `Approve` 为表示批准的标签，因此有能力的 UI 会把计划呈现为一次决定而非通用问题；两种情况下该工具读到的回答完全相同。放弃审阅 —— 用户关掉请求改用说话 —— 会如实报告给模型，要求它留在 plan mode 中等待那条消息；其余每一种评审失败都保留 seam 自身的消息。

组合 `ctx.commands` 时，该包（package）会注册 `/plan [message]`，并保留精确参数 `off` 用于直接退出。不带参数的 `/plan` 选择 plan mode；任何其他非空参数都会先选择 plan mode，再通过 `agent.steer()` 提交，因此它会在 plan 引导下成为下一步骤的常规已记录用户消息。`/plan off` 选择未激活状态，不发送模型输入；它还可以在 plan mode 进入选择到达请求之前取消该待生效选择。

TUI 消费插件拥有的 `/plan` 命令；其他入口可以直接驱动同一服务，无需定义第二套 mode 词汇。

## 会话投影

当组合挂载 `ctx.sessionProjections`（[`@deepseek-ai/dsh-session-projection`](../../session-projection/session-projection/README.md)）时，本包在注入子插件下注册 `plan` 投影单元。该单元折叠两种事件：名为 `plan` 的 `command/run` 记录设置目标值（`off` → 未激活，其余 → 激活），`plan/mode` 提交已记录状态并将其清除；其他任何事件返回同一状态引用。`view` 推导 `{ active, pending }`，其中 `pending` 仅在未兑现的选择不同于已记录状态时为 true——它是纯回放量，host 重启、其他标签页与冷读都只凭日志即可恢复（`/plan` 处理器在任何可能失败的路径之前调用 `set()`，使已入日志的请求与运行面不可能分叉）。key 从 `src/types.ts` merge 进 `SessionProjectionMap`（host 消费方经 `./types`、client 聚合经 `./client`）；框架驱动单元，载体在历史尾页与 `session/projection` 推送帧上提供该值。未挂注册表的组合不受影响。

## 配置

```yaml
- id: plan-mode
  name: '@deepseek-ai/dsh-plan-mode'
  config:
    section: |
      You are in plan mode. Explore and design before presenting the complete
      plan through exit_plan_mode.
```

`section` 必填且非空。未知键会在加载时失败。该包不接受任意具名 mode、工具过滤器、沙箱设置或批准策略。

设计：[plan 专用协作状态](../../../.agents/notes/implemented/simplification/2026-07-22-plan-specific-collaboration-state.md)。

## 模型体验

### Plan 策略系统提示词

#### 模型所见内容

Plan mode 激活时，模型会在提示词顺序 50 处看到部署所提供的精确 `section` 文本；未激活 mode 不贡献文本。

##### 配置示例

```markdown
You are in plan mode. Explore and design before presenting the complete plan through exit_plan_mode.
```

#### Token 影响

未激活 mode 不增加 token；已激活 mode 会在每个请求中添加已配置段。

#### KV Cache 影响

该段在 plan mode 内稳定，但进入或退出会从顺序 50 开始改变系统提示词。

### 人类命令

#### 模型所见内容

`/plan`、`/plan off` 及其终端结果留在模型历史之外。除精确 `off` 参数以外的非空后缀会在选择 plan mode 后，通过 `agent.steer()` 成为一个去除首尾空白的用户文本块。只有在最后一个请求头描述了 plan mode 时，已激活的 `/plan off` 选择才会贡献标准已记录用户切换通知；取消待生效进入不会贡献通知，因为没有请求观测到它。

#### Token 影响

可选消息的历史 token 成本与单独提交该文本相同；不带参数的 `/plan` 和 `/plan off` 不增加 token。经叙述的激活退出会添加一条短小且保留的切换通知。

#### KV Cache 影响

用户块是仅追加的对话增长。进入或退出 plan mode 会改变更早的策略段；经叙述的退出通知追加在可复用请求前缀之后。

### 退出工具 schema 与评审交换

#### 模型所见内容

[`exit_plan_mode` schema](../../../docs/tool-catalog.md#deepseek-aidsh-plan-mode) 在两种状态下均可用；在 plan mode 外执行会失败，而 plan mode 内经批准的评审会返回规范 `{ approved: true }` 值，并渲染现有确认文本。拒绝仍是携带评审反馈的失败调用，放弃审阅则是一次指明用户接手的失败调用。

#### Token 影响

稳定 schema 的成本取决于 ToolRegistry mode，每个 plan 参数与评审结果都保留在对话历史中。

#### KV Cache 影响

Mode 转换不改变工具目录；plan 参数与评审结果按常规方式扩展对话。

## 已知限制与延后工作

- Plan mode 只进行引导，而不强制执行；需要硬边界的部署必须组合独立的沙箱与批准控制。
- 如果进程在下一个边界之前退出，空闲时作出的待生效选择会丢失，因此 UI 必须重新应用它。
- Fork 的 agent 会继承已记录的 plan 状态，新 spawn 的 agent 则从未激活状态开始；不存在创建时 plan 选项。
- `exit_plan_mode` 评审弧有一个组装应用快照，即 Web `plan-review` e2e 通道（提交 → 决定卡片 → 已批准切换）。已拒绝反馈与放弃审阅两个分支仅由包测试覆盖，TUI 无密钥场景只演练 `/plan` 进入和 `/plan off` 退出。
- 只有 Web UI 渲染 `plan-review` 意图；TUI 通过其通用问题流程呈现该评审，可以回答，但读起来不像一个计划关口。
