# RFC：记录 fork 与混合 spawn+fork 快照场景

[English](2026-06-22-fork-snapshot-scenarios.md) | 中文

Status: implemented

## 问题

[seed-boundary RFC](2026-06-22-fork-child-replay-seed-boundary.md) 让 fork 子会话的回放路由正确工作了：`dsh-llm-replay` 从子会话持久化的 `seedLength` 边界处或之后的事件推导出子会话的脚本，因此 fork 子会话继承的父会话前缀不会被当作子会话自身的模型调用来回放。但该 RFC 交付时**没有录制 fork 场景**：切片逻辑仅由 `llm-replay` 的单元测试（一个合成的子会话 fixture（测试前置数据））和一个持久化往返测试覆盖。全 transcript（文本记录）快照层——那个启动真实 `acp-agent` 并回放端到端嵌套 transcript 的网——只有 spawn 子会话（`subagent-spawn`、`subagent-multi`）。一个让单元测试保持绿色的 fork 路由回归，仍然会逃过专为捕获 transcript 回归而建的那一层。

表达 fork 场景所需的快照基础设施已经就位：两个进程内后端都通过 `cordis.yml` / `cordis.snapshot.yml` 接入为两个面向模型的工具（`subagent` → spawn、`subagent_fork` → fork），harness 收集每个子会话的日志，回放按 `seedLength` 为键转发每个子会话的 fixture。缺少的只是一个*录制好的场景*来驱动 fork 子会话走完这条路径。

## 决策

对真实 API 录制两个场景，均在默认门禁中以 keyless 方式回放：

- **`subagent-fork`**：父会话完成一个轮次以建立一个事实，然后通过 `subagent_fork` 委派一个子任务。fork 子会话继承对话（其日志携带非零 `seedLength`），因此能从父会话的上下文中作答。这是聚焦的回归守卫：子会话 fixture 的 `seedLength` 就是回放切片所依赖的边界，来自真实 fork 的录制而非手工合成。
- **`subagent-mixed`**：父会话完成一个轮次，然后在同一个 transcript 中分别通过 `subagent`（全新的 spawn 子会话，`seedLength` 为 0）和 `subagent_fork`（fork 子会话，非零 `seedLength`）各委派一次。这是 seed-boundary 和 per-session-replay 两份 RFC 都提到的「未来补充」的混合 spawn+fork 场景：一个 transcript 同时覆盖两种传输方式和切片的两个分支（`seedLength` 0 = 无操作，`seedLength > 0` = 裁掉继承的前缀），两个子会话按 `createdAt` 排序为先 spawn 后 fork。

### 为什么需要一个已完成的第一轮次

fork 后端用父会话的**已完成轮次的平衡前缀**（[`completedTurnPrefix`](../../../../packages/subagent/subagent-fork)）来填充子会话种子。如果父会话在第一个轮次就 fork，则没有已完成的轮次可继承，种子为空（≡ 全新 spawn，`seedLength` 为 0），这**不会**覆盖切片逻辑。因此两个场景都使用两条提示词输入：第一条提示词完成一个轮次（建立一个 codeword 供子会话稍后回忆），第二条委派 fork。子会话 transcript 中回忆出的 codeword 只是模型行为的附带结果；真正承载验证的产物是子会话 fixture 中录制的 `seedLength`，回放切片消费的正是它。

## 后果

- fork 路由切片现在由全 transcript 层守卫，而不仅仅是单元测试。移除 `slice(seedLength)`（回放整个子会话日志）会让**两个**新场景变红——fork 子会话收到的是父会话录制的 chunk 而非自己的——证明守卫确实生效（场景落地时已验证红→绿）。
- `subagent-mixed` 是第一个在同一个 transcript 中驱动两个*不同* subagent 后端的快照场景，同时覆盖了跨 spawn 和 fork 子会话的 per-session 回放键控。
- 进程外（ACP）subagent 回放是另一种形态（每个子会话是独立进程、有自己的回放），仍以 `TODO(acp-subagent-replay)` 跟踪——本文场景仅限进程内。
- 重新录制（`pnpm run test:snapshot:record`）会从真实 API 重新生成全部四个 fork/spawn fixture；两个新场景在没有 key 时与所有录制场景一样自动跳过。

<!-- rfc-format: alternatives-not-recorded (pre-format RFC) -->
