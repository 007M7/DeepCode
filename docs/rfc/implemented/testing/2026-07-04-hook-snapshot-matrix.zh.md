# RFC：钩子快照矩阵——覆盖两种桥接的端到端金标测试

Status: implemented

[English](2026-07-04-hook-snapshot-matrix.md) | 中文

## 问题

钩子桥接——[`dsh-hooks-claude`](../../../../packages/hooks/hooks-claude)（7 个 Claude Code 钩子点）与 [`dsh-hooks-codex`](../../../../packages/hooks/hooks-codex)（5 个 Codex 钩子点）——将外部钩子命令映射到 harness 的拦截 seam 上。它们拥有深度的单元测试与覆盖率规格覆盖（每个决策分支、每种 payload 方言，均对 mock seam 驱动），外加一个需要密钥的 e2e 测试（`hooks.e2e.ts`，一次真实的 `PreToolUse` 拦截）。但全 transcript（文本记录）快照层——那张真正启动 `acp-agent` 子进程、无密钥回放录制会话、并将归一化的 ACP stdout 与重新持久化的日志对比已提交金标的网——只覆盖了**一个**钩子：Claude 的 `UserPromptSubmit` 拦截（`hook-cc-promptsubmit-block`）。

这正是 mock 单元测试在结构上无法替代的层级：它让真实的桥接翻译真实钩子进程的结果，送入真实的 seam 决策，再由真实的 agent loop（智能体循环）做出反应，渲染结果与编辑器所见完全一致。一个桥接翻译或循环结构的回归，即使让所有单元测试保持绿色，也会在除那一个钩子点之外的所有点上逃逸——而对于 Codex 桥接，ACP 示例甚至没有加载它，因此没有任何 Codex 钩子能端到端触发。

## 决策

实现由两个耦合部分组成：

### 1. ACP 示例同时加载两种钩子桥接

`examples/acp-agent/cordis.yml` 与 `cordis.snapshot.yml` 现在在 `dsh-hooks-claude` 之外同时加载 `dsh-hooks-codex`，各自指向自己的配置文件（Claude 用 `./hooks.json`，Codex 用 `./codex-hooks.json`——两种方言无法共用一个文件）。这是一个真正的产品表面变更，而非仅测试用的接线：交付的 ACP 服务器（以及 `demo:acp` 入口）现在同时携带两种桥接。

这是安全的，因为配置文件不存在时桥接是**静默空操作**：`apply()` 捕获读取失败、通过 `ctx.logger` 记录日志、不注册任何东西——零监听器、零会话事件。`acp-agent` 应用不挂载 stdout logger，因此该警告不会到达 ACP JSON-RPC 通道。只需要 Claude 钩子的场景（或真实项目）只提供 `hooks.json`；Codex 桥接找不到 `codex-hooks.json` 便自行消失。这已通过实验验证：两种桥接同时加载时，所有既有快照（均未提供 `codex-hooks.json`）逐字节一致。

同时加载是让快照层能够在产品交付的同一个真实应用上对每种方言进行测试的最低要求。录制（启动 `cordis.yml`）天然加载两者，回放以同样方式继承：`cordis.snapshot.yml` 是 `cordis.yml` 的 include-overlay，仅替换 llm 条目（见 [single-source the acp-agent replay config](2026-07-04-single-source-acp-replay-config.md)），因此添加到运行时配置树的桥接无需第二次编辑即出现在回放树中。

### 2. 每个钩子点 × 其标志性结果各一个快照场景，覆盖两种方言

`examples/acp-agent/tests/snapshots/` 下共 13 个场景，命名为 `hook-<dialect>-<point>-<outcome>`：

- **手工编写、无模型轮次**（无密钥、无 sidecar——派生的回放脚本为空；比对的是携带 `hook/*` 事件的 `rejected` 轮次）：`hook-cc-promptsubmit-block`、`hook-codex-promptsubmit-block`。
- **对真实 API 录制、录制期间钩子活跃**（模型对决策的反应是捕获的 transcript 的一部分，此后无密钥回放）：`hook-{cc,codex}-promptsubmit-context`（allow + additionalContext 折叠）、`hook-cc-pretool-deny` / `hook-codex-pretool-block`（deny → `isError` 工具结果）、`hook-cc-pretool-ask`（ask → 降级为 deny 并附带 approval-required 原因）、`hook-{cc,codex}-posttool-block`（block 并附反馈）、`hook-{cc,codex}-posttool-context`（accept + additionalContext）、`hook-{cc,codex}-stop-continue`（阻塞式 Stop 钩子通过 steering（中途引导）强制多走一步）。

每个钩子命令只输出**固定字面字符串**（无时间戳/pid/`$RANDOM`/cwd 回显）；快照归一化器擦除 `hook/result` 携带的唯一易变字段（`durationMs`）。`Stop` 场景通过标记文件（`.stop_fired`）自限，使 force-continue 不会循环——`stop_hook_active` 循环守卫仍是桥接的一个 `TODO`，因此无条件的 Stop 钩子会对每一步都 force-continue。

### 三个钩子点被有意排除在快照之外

在构建矩阵过程中发现，记录在此是因为这是一个决策而非疏漏：

- **`SessionStart` 与 `SubagentStart`** 通过一个分离的、尽力而为的 `void runPoint(...).then(agent.inject())` 注入上下文，**没有轮次绑定**。产生的 `context/message` 与它所先于的工作（首次模型请求/子 agent 的首轮）存在竞争，落在日志中的位置不确定。录制的金标甚至在自身回放时都无法复现——10 次回放稳定性检查对两者均 10/10 失败。它们留在桥接的单元覆盖中，单元测试直接驱动 seam 而无时序竞争。（如果注入将来变为轮次绑定且确定性的——`TODO(session-start-gating)` 所指的方向——这些点就可以纳入快照。）
- **`SubagentStop`** 是纯观察：其 `subagent/end` 处理器不传递轮次（因此无 `hook/*` 日志事件）、不做注入。它对 transcript **什么都不写**，因此金标会与无钩子运行逐字节一致，永远无法被证明失败——一道咬不到人的守卫。它留在单元覆盖中（`bridge.spec.ts` 已断言该纯观察调用）。

因此该矩阵覆盖了所有具有**确定性、可观测 transcript 足迹**的钩子点，涵盖两种方言。

## 后果

- 每个具有可观测 transcript 的桥接 seam 映射现在都在全 transcript 层、在真实应用中、为两种方言设有守卫——包括此前完全没有端到端覆盖的 Codex 桥接。录制的金标捕获了模型对 denied/blocked/force-continued 轮次的真实反应，这是手工编写的 transcript 只能猜测的。
- block 场景无需密钥（无模型轮次）；其余场景从录制的 fixture（测试前置数据）无密钥回放。`pnpm run test:snapshot:record` 从真实 API 重新生成录制的 fixture，无密钥时像所有录制场景一样自动跳过。
- prove-red 纪律成立：篡改钩子配置的输出（例如修改 deny 原因）会使其场景在回放时变红——钩子进程在回放期间**真实运行**（只有模型被回放），因此金标守卫的是实际的 hook→seam→loop 路径，而非它的 mock。
- `acp-agent` 演示现在加载了一个通常会空操作的 Codex 桥接（典型项目中没有 `codex-hooks.json`），这正是预期的 fail-soft 行为，而非代价。

<!-- rfc-format: alternatives-not-recorded (pre-format RFC) -->
