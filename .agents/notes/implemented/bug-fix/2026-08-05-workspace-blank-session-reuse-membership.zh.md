# Agent Note：工作区新建会话复用了 cwd 匹配但未入账的空白会话

状态：已实现

[English](2026-08-05-workspace-blank-session-reuse-membership.md) | 中文

## 问题

在侧边栏某个工作区分组的 `+` 上创建会话时，有时会进入一个新会话，但侧边栏把它显示在「未分组」而不是点击的那个工作区下——「进入了新会话，但工作区没有被选中」。故障只出现在注册在 CLI 运行目录（即 `defaults.cwd = process.cwd()`，实际场景里就是 harness 检出目录本身）上的工作区，并且一旦该目录下存在 CLI 创建的空白会话就会出现。

根因：`connectWorkspace` 的空白会话复用扫描只按 `cwd` 相等匹配会话列表镜像。host 自己的成员规则要求**同时**满足：会话 id 在工作区账户（`sessionIds`）中，**且**会话 header 的规范化 cwd 等于工作区路径（[Workspace UI product flow](2026-07-25-workspace-ui-product-flow.md)）；只有 cwd 匹配而没有账户槽位的恰恰就是「未分组」的情形。复用扫描忽略了账户槽位，因此任何 cwd 匹配的**在线空白**会话都会被选中——包括 CLI/TUI/headless 入口在 host cwd 创建的 `main-session-*` 会话（`session.create({})` 回退到 `defaults.cwd`，从不挂到任何工作区）。当这样的会话在线且空白（尚无 `turn/start`）时，下一次在该路径注册的工作区上点击 `+` 就会复用它，导航打开的是一个任何分组表面都无法显示在该工作区下的会话。其他路径的工作区不受影响，因为那里不会积累未入账的空白会话；而 host-cwd 工作区每次 CLI 运行都会积累一个。

## 决定

复用扫描现在要求工作区成员关系：`blank` 且 `summary.cwd === workspace.path` 且 `workspace.sessionIds.includes(summary.id)` 且未归档。仅 cwd 匹配的情况落到 `session.create({ workspaceId })`，创建并挂接新会话，使工作区拥有它——这与流程中「不存在空白会话」时的既有分支完全相同。

## 曾考虑的替代方案

**收养游离会话而不是新建。** 让 `session.create({ workspaceId })` 挂接一个 cwd 匹配但未入账的空白会话。否决：静默地把 CLI 创建的会话挂到工作区上，越过了账户边界，令人意外；而且客户端没有成员视图就无法区分「游离会话」与「工作区自己的空白会话」——而成员视图本身就是本次修复。

**复用时就地挂接，新增一条 wire 操作。** 需要在导航热路径上新增 `workspace.attachSession` RPC，并且会话仍会有一帧显示在「未分组」；没有产品需求值得新增这个表面。

## 后果

游离空白会话仍显示在「未分组」（用户仍可手动打开），但不再被某个工作区的新建会话流程劫持。客户端镜像滞后（工作区帧落后于账户）时可能错过复用窗口而改为新建——这是既有的竞态行为，已按工作区合并。无 host、wire 或持久化格式变更。

## 测试

`packages/client/runtime/tests/workspaces-service.spec.ts` 覆盖四种结果：成员空白会话被复用（无 create RPC）；cwd 匹配但非成员的游离空白会话**不被**复用、改为创建全新入账会话（回归用例）；已归档空白会话不被复用；首次 prompt 被拒后成员空白会话仍可复用。完整客户端套件（`pnpm run test:gui`）保持绿色。
