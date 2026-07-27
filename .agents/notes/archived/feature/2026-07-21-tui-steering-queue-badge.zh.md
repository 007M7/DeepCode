# Agent Note: TUI 状态行标示排队中的 steering 消息

Status: implemented
Archived: 2026-07-26

[English](2026-07-21-tui-steering-queue-badge.md) | 中文

## Problem

轮次运行期间，编辑器提交会调用 `agent.steer()`，在运行中的轮次后面加入 steering（中途引导）队列（[前门 Agent Note](2026-07-17-dedicated-full-screen-tui-front-door.md)）。运行时的状态行只以 `Enter sends steering, Esc cancels` 提示收尾，因此按下 Enter 后没有任何反馈表明消息已入队、也看不出有多少条正在等待送达模型。连续 steering 多次的用户无法把队列和被吞掉的按键区分开。

## Decision

agent（智能体）的收件箱（inbox）才是权威的 steering 队列，但 TUI 无法观测它，因此徽标是根据 TUI 成功提交的 steering 和 `steering/message` 事件重建出的实时计数，而非对队列本身的投影。

- 运行时的状态行经 `formatTurnStatus` 组装：`queued > 0` 时在 `Enter sends steering, Esc cancels` 提示前插入 `${queued} queued · ` 徽标，为零时是纯提示文本；其前的阶段标签与耗时归[详细状态行](2026-07-21-tui-verbose-status-line.md)所有。
- `createTuiChat` 记录每一次在 `running` 状态下成功的 `agent.steer()` 提交；agent loop（智能体循环）每排空一条并发出 `steering/message` 会话事件时，就按来源移除匹配项；agent 离开 `running` 时则重置整个列表。
- 计数通过 `setMessage` 刷新到实时的 `Loader` 上；空闲时刷新是空操作，因为 loader 只在运行中的轮次期间存在。
- 重置放在 `agent/status` 状态切换里，而非 `setStatus` 中，因为 `setStatus` 在轮次中途的颜色方案变化时也会运行，绝不能清掉一个实时计数。

## Alternatives considered

**仅从会话日志推导计数**（入队数减去排空数，回放时重算）。否决：取消会清空 inbox 而不记录排空，因此日志无法区分一条消息是被排空还是被丢弃；「离开运行态即重置」这个锚点更简单，且每轮自我校正。

**在 `setStatus` 内重置。** 否决：`setStatus` 会在轮次中途的 `applyColorScheme` 时重新运行，会错误地把实时计数清零；状态切换才是轮次真正结束的唯一位置。

**统计每一次公开的 inbox 入队。** 否决：`AgentMessage` 刻意省略驱动器路由状态，因此观察方无法区分排队轮次与 steering。TUI 转而自行维护徽标所代表的那些提交。

**把措辞或某个阈值做成配置。** 否决：「插件里不许硬编码可调参数」规则针对的是随部署变化的行为，不是品牌文案；`welcome`/提示字符串本就是固定的展示文案。

## Consequences

- 徽标是尽力而为的实时 UI 状态，不写入日志：它由事件重建、每轮重置、从不持久化，因此恢复（resume）出的运行中轮次徽标从零开始。
- 队列中途取消会经由「离开运行态即重置」干净地清掉徽标，排空到零以下则是空操作——两者都不会残留一个陈旧计数。
- 通过此 TUI 以外的入口提交的 steering 不会出现在徽标中；该计数反馈的是此编辑器的提交，而不是 agent 的完整 inbox。
- `packages/ui/tui/src/index.ts` 保持 100% 的单文件覆盖率。

## Testing

`packages/ui/tui/tests/tui.spec.ts` 通过真实的 `createTuiChat` 驱动运行时状态帧：为零时显示纯提示，编辑器提交后递增到 `2 queued`，每条消息排空时递减，忽略无关的排空，并在轮次结束时重置。
