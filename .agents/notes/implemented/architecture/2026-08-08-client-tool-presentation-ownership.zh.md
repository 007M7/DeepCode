# Agent Note: Client Tool 展示所有权

Status: implemented

[English](2026-08-08-client-tool-presentation-ownership.md) | 中文

## Problem

Client Runtime 已经把 Tool 调用投影成稳定的生命周期：它按 `callId` 配对 call/result 事件，保留 running 与 settled 两种形态，并按 root call 索引 Code Dispatch 子调用。但 chat view 仍拥有整套展示链路：它在 ChatFlow 中放置 root call，把每个 root 与 subcall 编排在一起，按 Tool 名称分发每个原子调用，携带通用 fallback 与 card model，注册第一方 Tool view，并在 details panel 中复用这些 model。

这种所有权迫使 `ui-conversation` 解释业务 Tool 名称；一旦原子 Tool view 被迁走，subcall 就会成为无主的遗留关注点。`ui-skill` 等业务包虽能注册一行视图，仍依赖 conversation 的 Tool 专属编排契约。增加 Tool 专属 Session projection 会重复 Runtime 已拥有的数据模型，而只移动单个 React 组件则会把编排与 model 耦合留在原地。

## Decision

Tool 成为 Client UI 的一级概念，并由 `@deepseek-ai/dsh-client-ui-tool` 统一拥有展示。Session Event、projection、fold、`ConversationSnapshot` 构建与缓存、历史分页及 Code Dispatch 索引保持不变。

这里的“一级概念”只描述 UI 所有权，不增加 Runtime 数据种类。`ConversationNode` 仍是 transcript projection，`ChatFlowItem` 仍是 conversation 对节点进行排序与分组后得到的渲染单元，`ToolCallBlock` 仍是单次调用的标准数据，而 `ToolCallTree` 只负责 Tool 内部的 root/subcall 展示编排。Command 继续通过独立的 `'conversation.chat.commandview'` 席位渲染，不并入 Tool。

`ui-conversation` 拥有有序放置。`deriveChatFlow()` 仍决定 settled Tool group 在哪里出现，`ChatView` 仍追加 running call、维护滚动 anchor 与 selection，并提供宿主动作。对于每个 root call，它使用 root block、selected call id、session cwd 以及 open-file/inspect 回调渲染 single/session 的 `'conversation.chat.tool'` 席位。它不读取 Code Dispatch child、不按 Tool 名称分支，也不导入 Tool 专属 view 或 card model。

`ui-tool` 占据这个整体 Tool 席位。`ToolCallTree` 通过标准 session slot props 选择 Runtime 投影的 `codeDispatches[rootCallId]` 数组，先渲染 root，再渲染当前支持的一层 child；两种调用都通过同一个 keyed/session 的 `'tool.call.toolview'` 子 slot，以 `entryKey: toolName` 分发。业务未注册时渲染 `GenericToolCard`。这里刻意只编排一层，并不声称 Runtime 已支持任意递归调用图。

业务插件只对 `'tool.call.toolview'` 注册原子 view。其 owner payload 是标准 Tool call block 加 identity、cwd 与宿主动作，不携带 Session projector 或 conversation service。Skill 仍是普通 Tool，`ui-skill` 通过该 seam 注册 `skill` key。现有第一方 view 暂留在 `ui-tool`，直到某个业务包确有理由独立拥有它。

details panel 是第二个 Tool 展示点，但不是调用树所有者。`ui-conversation` 通过 single/session 的 `'conversation.details.tool'` 席位委托 selected output body；`ui-tool` 渲染能够识别 card 的输出，插件缺席时由席位 fallback 保留 raw result text。因此 card model 只有一个生产代码所有者，也不需要引入反向实现依赖。

Runtime 仍是 Tool 生命周期与调用拓扑的权威。Code Dispatch 会改变 `codeDispatches` 与 parent/child identity，因此继续作为官方顶级概念；普通 Tool 业务差异停留在 keyed 展示 seam。这个包边界不会增加 Tool projector/fold registry。

## Runtime 与渲染链路

这项边界从 Client 的 `ConversationSnapshot` 开始，完整渲染链路如下：

```text
ConversationSnapshot.nodes
  -> deriveChatFlow()
  -> settled tool-group positions ----+
                                      |
ConversationSnapshot.runningCalls     |
  -> ChatView flow tail ---------------+-> ToolSeat
                                           -> conversation.chat.tool
                                           -> ToolCallTree
ConversationSnapshot.codeDispatches[rootCallId] -+
                                                  +-> root ToolCall + one-level child ToolCall
                                                      -> tool.call.toolview(entryKey = toolName)
                                                           |- registered atomic view
                                                           `- GenericToolCard fallback
```

Live Session 的 [`Session.buildSnapshot()`](../../../../packages/client/runtime/src/client/sessions/session.ts) 按独立 revision 缓存 `nodes`、`runningCalls`、`codeDispatches` 等数组或 map；没有对应业务变化时，它们保持引用稳定，供 React selector 与 memo 跳过无关更新。历史 projection 的 [`projectConversationHistory()`](../../../../packages/client/runtime/src/client/session-history/history-fold.ts) 从窗口内 entry 重建相同的 running call 与 Code Dispatch 形态。Tool UI 直接消费这两个路径已经统一的 snapshot，不在展示包中重复 call/result 配对、历史 replay 或缓存索引。

[`ChatView`](../../../../packages/client/ui-conversation/src/client/chat/ChatView.tsx) 只在 `nodes` 引用变化时重新执行 [`deriveChatFlow()`](../../../../packages/client/ui-conversation/src/client/chat/chat-flow.ts)，把连续 settled Tool result 合为 `tool-group`；running root call 则追加在 flow tail。两条路径最终都进入同一个 `ToolSeat`，因此 settled/running 形态共享整体 Tool 席位。`ToolCallTree` 只选择当前 root 的 `codeDispatches[rootCallId]`，不会因其他 root 的展示逻辑引入业务 projector。

## 代码与职责边界

| 所有者 | 主要代码 | 拥有的责任 | 明确不拥有 |
|---|---|---|---|
| Client Runtime | [`Session`](../../../../packages/client/runtime/src/client/sessions/session.ts)、[`history-fold.ts`](../../../../packages/client/runtime/src/client/session-history/history-fold.ts) | call/result 配对、running/settled 生命周期、Code Dispatch parent/child 索引、snapshot 引用稳定性 | Tool 名称对应的业务视图 |
| `ui-conversation` | [`chat-flow.ts`](../../../../packages/client/ui-conversation/src/client/chat/chat-flow.ts)、[`ChatView.tsx`](../../../../packages/client/ui-conversation/src/client/chat/ChatView.tsx)、[`slots.ts`](../../../../packages/client/ui-conversation/src/client/contract/slots.ts) | ChatFlow 顺序、settled group、running tail、scroll anchor、selection 与宿主动作、整体 Tool 席位声明 | subcall 组合、按 `toolName` 分发、Generic fallback、Tool card model |
| `ui-tool` | [`apply.ts`](../../../../packages/client/ui-tool/src/client/apply.ts)、[`ToolCallTree.tsx`](../../../../packages/client/ui-tool/src/client/tool/ToolCallTree.tsx)、[`slots.ts`](../../../../packages/client/ui-tool/src/client/contract/slots.ts) | root/subcall 组合、原子 keyed dispatch、Generic fallback、Tool card model 与内置 Tool view | ChatFlow 排序、Session Event fold |
| 业务 Tool 插件 | [`ui-skill` 注册例](../../../../packages/client/ui-skill/src/client/index.ts) | 一个或多个 wire Tool name 的原子 view | root/subcall 位置与生命周期配对 |
| details 路径 | [`DetailsPanel.tsx`](../../../../packages/client/ui-conversation/src/client/skeleton/DetailsPanel.tsx)、[`ToolDetails.tsx`](../../../../packages/client/ui-tool/src/client/tool/ToolDetails.tsx) | selected call 定位、card-aware output 与 raw fallback | chat 调用树编排 |

## Slot 与 owner 契约

slot 声明同时限定渲染所有权。conversation chat entry 通过 `children` 声明 `'conversation.chat.tool'`，因此只有 `ChatView` 放置整体 Tool 席位；`ui-tool` 注册该席位时再通过 `children` 声明 `'tool.call.toolview'`，因此只有 `ToolCallTree` 渲染原子 Tool 席位。业务插件只注册 keyed entry，不参与 root/subcall 编排，也不建立与 slot 平行的 registry。

整体席位的 `ToolTreeOwnerProps` 携带 root `callId`、`toolName`、`ToolCallBlock`、`selectedCallId`、session `cwd`、`openFile(path)` 与 `inspectCall(callId)`。`ToolCallTree` 把 root 或 child 转成相同的 `ToolCallOwnerProps`，并把 inspect 收窄成当前 call 的回调。原子 owner 不携带 `ReactNode`、Cordis `Context`、Session service 或 projector；业务 view 只消费一个标准调用块和宿主动作。

席位填充方还要在每个 root 和 child wrapper 上保留 conversation DOM 契约：`data-chat-anchor-key="call:<callId>"`、`data-chat-call-id`，以及 selected call 上的 `data-selected="true"`。`ChatView` 用 anchor key 恢复 prepend/paging 位置；child wrapper 由 Tool owner 独自编排，因此这些属性也由它输出。

业务插件遵循同一个注册形态：

```text
ctx.slots.inject('tool.call.toolview', () =>
  ctx.slots.register({
    name: 'tool.call.toolview',
    key: '<wire tool name>',
  }, BusinessToolRow))
```

`ui-tool` 的 [`apply()`](../../../../packages/client/ui-tool/src/client/apply.ts) 注册整体 Tool renderer、details renderer 与现有内置原子 view；已有独立业务包可以像 `ui-skill` 一样只迁走自己的 keyed 注册，无需改动 `ui-conversation` 或 Session。

## Details 路径

[`DetailsPanel`](../../../../packages/client/ui-conversation/src/client/skeleton/DetailsPanel.tsx) 仍从 `nodes`、`runningCalls` 与 `codeDispatches` 中定位选中的 call，并拥有 input 参数、空态和面板生命周期。它只把 `{ block, cwd }` 交给 `'conversation.details.tool'`；[`ToolDetails`](../../../../packages/client/ui-tool/src/client/tool/ToolDetails.tsx) 复用 Tool card model 渲染 output。`ui-tool` 缺席时，settled call 回退为 raw result text，running call 显示 conversation 的 running fallback，因此 details 不反向导入 Tool 实现。

## Verification

测试归属跟随生产所有权。`ui-conversation` 的测试安装本地整体 Tool 席位替身，只验证 ChatFlow 位置、owner payload 与 selection、open-file、inspect 等宿主契约；它们不导入 `ui-tool` 的生产实现或测试 helper。`ui-tool` 的测试挂载真实 conversation 宿主，验证 root/subcall 编排、keyed dispatch、generic fallback、具体 Tool UI 与插件生命周期。

## Alternatives considered

**在每个 conversation view 下保留原子 Tool slot。** 拒绝：每个 view 都必须重复 root/subcall 编排，而且 Tool 注册会按 view 隔离，即使它的业务语义本应是 Tool 级。整体 Tool 席位保留 view 对放置位置的所有权，同时让调用树只有一个所有者。它取代了早期 [toolview 溶解](2026-07-23-toolview-dissolution.md)所选择的 per-view 放置方式，但保留 keyed slot 与不设平行 registry 的决策。

**只移动 Tool React 组件与 card model。** 拒绝：`ChatView` 仍会拥有 Tool 名称分发与 Code Dispatch 编排，只是改变文件路径，没有改变责任。

**增加业务专属 Session projector 或 fold。** 拒绝：普通 Tool view 消费 Runtime 已重建的标准 call block。第二套 registry 会为 call identity 与历史 replay 建立两个权威。只有会改变日志拓扑或生命周期的能力才应获得 Runtime 级扩展。

**让每个原子 Tool view 递归渲染自己的 subcall。** 拒绝：原子注册方只接收一个 Tool call，不应知道自己是 root 还是 child。root/child 编排归 `ui-tool`，且当前 wire/runtime 形态只支持一层 Code Dispatch child。

**让 `ui-conversation` 直接导入 `ui-tool` 组件。** 拒绝：这会反转预期的 feature 依赖方向，并把 Tool 展示变成必选能力。声明式 slot 能保留生命周期所有权、fallback 行为与独立插件装载。

## Consequences

`ui-conversation` 不再依赖 Tool 名称对应的业务展示，同时保留 ChatFlow、selection 与宿主交互责任。root call 与 subcall 不会漂移到不同分发路径，业务包无需修改 Session 即可拥有原子 Tool 展示。代价是新增一个 Client package 与两个跨包 slot seam；`ui-tool` 也明确依赖 conversation 声明的席位与 locale namespace。因此组装后的 Web bundle 会挂载 `ui-tool`；省略该插件时，chat Tool 席位为空，details 席位则保留 raw-result fallback，且 Session 重建不受影响。
