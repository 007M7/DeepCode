# @deepseek-ai/dsh-goal

[English](README.md) | 中文

事件溯源的同会话目标状态。该服务在 agent（智能体）的现有会话中保留一个当前完成目标，同时将继续执行的权限作为进程本地续行启用状态。[goal 领域 Agent Note（agent 决策记录）](../../../.agents/notes/implemented/feature/2026-07-19-persisted-same-session-goal-domain.md) 负责设计理由；[goal 类型目录](../../../docs/core-data-structures/goal.md)记录具体的数据形状。

## 配置

```yaml
- id: goal
  name: '@deepseek-ai/dsh-goal'
  config:
    defaultMaxGoalRounds: 256
```

`defaultMaxGoalRounds` 必须是正的安全整数。`create()` 会在提交目标前于内部物化这项部署默认值；请求级取值可以覆盖它。

## 服务契约

`ctx.goals` 只接受以对应 id 注册的完全相同的活跃 `Agent` 实例。`get()` 返回与内部状态脱离的 `GoalView`；变更通过 `GoalRef { id, revision }` 比较并设置屏障，并拒绝陈旧引用。服务通过生成的[服务目录](../../../docs/cordis-catalog/services.md)公开 create、edit、pause、resume、complete、block 和 clear 动词。创建默认值在内部解析。`disarm()` 是仅供生命周期使用的例外：它移除进程本地续行权限，不写入新 revision，也不发出变更。

最多只有一个当前目标。创建操作会生成 revision 为 1、phase 为 active 的目标并启用续行。未完成的目标必须编辑、转换或清除；已完成目标可以由拥有全局未使用过的 id 的目标替换。编辑会保留 phase、blocker reason 与 activation。暂停、完成、阻塞和清除都会停用续行。阻塞会记录策略自有的 lower-kebab-case 代码和规范化的自由文本说明；提供方限制、配置预算、执行错误与请求人工输入都使用这一种持久 phase，不会扩增生命周期状态。只有配置的 Round 上限仍有剩余容量时，resume 才接受已停止 phase 或 phase 为 active 但已停用续行的目标；它会清除原 blocker reason。phase 为 active 且已启用续行的目标会拒绝冗余操作。

每次非 clear 变更都会通过 `agent.inject()` 追加完整的版本化快照；clear 则追加带 revision 的 tombstone。模型可见的 `user/message` 内容与其带类型的 `{ kind: 'goal', change }` 来源必须完全一致。回放会拒绝形状错误、来源／内容漂移、不连续 revision、非法生命周期转换、每目标时间戳非单调，以及不连续的 Goal Round。挂钟时间倒退时，变更时间戳会限制在不早于上一次目标更新的值。

注入可以立即追加，也可能在活跃工具批次 FIFO 中等待。服务会在内存中叠加已接受的待处理变更，并在每个完全一致的载荷进入日志时逐一完成对账，因此连续的模型工具变更可以看到自身最新 revision，而不会把尚未记录的缓存当作持久状态。可重入追加观察者会且只会看到每项已接受变更一次；增量回放会把游标保留在第一个损坏事件处。追加或入队成功后才触发 `goal/changed`；监听器失败会被隔离处理。

续行启用状态绝不持久化。新缓存与每次触发 `agent/session-start` 时都会停用续行，即使回放找到了持久 phase 为 active 的目标。续行驱动器在卸载前或持久性不确定后也会调用 `disarm()`。因此，会话恢复、fork 与驱动器替换会保留目标、phase、revision 和已准入 Round 数量，却不会启动工作；之后必须通过显式 resume 变更重新启用续行。

单独发布的 `./invariant` 配套模块会为每个已挂接会话维护独立折叠。它会在候选事件进入持久日志前拒绝格式错误的 goal 来源变更、模型可见内容漂移、不连续 revision、非法生命周期转换、时间戳回退，以及不连续的已准入 round。

## 扩展点

策略插件调用服务动词，并响应限定范围的 `goal/changed` 事件。续行消费方将 Round 准入为 `user/message` 事件，并携带 `GoalMessageSource`；普通的人类轮次绝不会增加 `roundsStarted`。消费方使用 `Agent` 接口和事件，不导入 `dsh-agent-loop`。

## 模型体验

### 目标状态变更

#### 模型看到的内容

每项变更都是一个原始用户角色上下文块。快照渲染为 `<goal_state>{"goal":...,"roundsStarted":...,"createdAt":...,"updatedAt":...}</goal_state>`；clear 会渲染 tombstone id／revision 与 `clearedAt`。日志外不存在隐藏状态摘要。这种描述性 XML 分隔符遵循仓库已有的 `<workspace_context>` 约定和 [Anthropic 发布的 XML 标签提示词指南](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices#structure-prompts-with-xml-tags)；它是公开的模型体验先例，并非关于任何提供方专有训练语料的声明。

#### Token 影响

每项保留的变更都会向派生历史增加一份完整快照，直到压缩（compaction）将其遮蔽。完整快照让每条记录都能独立检查，但会重复目标和生命周期字段。

#### KV Cache 影响

在一个 epoch 内仅追加：每项变更都位于可复用请求前缀和既有历史之后。压缩可能替换派生历史后缀，并移动可复用边界。

## 已知限制与暂缓事项

- **只负责状态，不负责任务调度**：此包（package）不决定已启用续行的目标何时继续，不重试异常失败，也不取消活跃轮次；这些策略属于 agent seam 消费方。
- **只有 Round 数量预算**：`maxGoalRounds` 不计量 token、货币、挂钟时间或提供方配额。
- **没有独立评估器**：记录完成或阻塞的调用方拥有最终决定权；由评估器支持的认证暂缓到独立策略层。
- **只有一个当前目标**：系统有意不支持并行目标或独立目标数据库；替换或清除后，历史仍可在会话日志中读取。
- **信任进程内生产方**：能直接访问 `Session` 的插件可以追加伪造的 goal 来源数据。严格回放会检测格式错误或不一致的记录，并使 goal 访问从该记录起失败，直到日志修复；这是完整性检测，不是插件隔离。
