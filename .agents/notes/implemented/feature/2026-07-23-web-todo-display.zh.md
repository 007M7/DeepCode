# Agent Note: Web todo 展示——快照副作用通道 + 两个渲染面

Status: implemented

[English](2026-07-23-web-todo-display.md) | 中文

## Problem

`todo_write` 把 `todo/write` 的整份列表快照追加进会话日志；TUI 渲染一块常驻的 plan 面板，ACP 桥接把该事件映射为原生 `plan` 更新。Web 客户端把这个事件整个丢弃了：host mux 流本已转发每一个会话事件，但 `todo/write` 不是 surface 类型（它从不 fold 进 `ConversationSnapshot.nodes`），也没有任何副作用分支累积它——浏览器既无消费点，也无展示面。

## Decision

把 `todo/write` 当作 Session 副作用消费，而非 surface 节点，并在两个面上渲染它，这两个面正对应 TUI 与 ACP 已经绘制的那套划分。

### 副作用通道，与窗口回放收敛

`applyEventSideEffects` 新增一个 `todo/write` 分支（整份列表，后写覆盖先写）。与 partial/openCalls 不同，`rebuildDerivedFromWindow` 刻意不重置它：该值是会话级的——由尾页 history 携带的全量 log 投影播种——而任意窗口未必包含最近一次写入，因此窗口重建（分页、重连缝合、resync）保留它，只有窗口内或实时的写入才会覆盖。`ConversationSnapshot.todos` 是读取面。这遵循事件自身的契约（「仅日志 UI 状态，绝非派生历史」）：把每次写入作为对话节点呈现，会让已被取代的列表看起来仍然有效。

### TodoPanel：长驻列表作为一条常驻横条

骨架把面板钉在视图区与 composer 之间（composer-card 轴），空列表时隐藏，可折叠——折叠态以进行中项作为单行提示；✓/●/○ 字形与 TUI plan 面板一致。它经框架 `useSession` hook 读取 `snapshot.todos`——无 store、无 service、无 ctx。它住在 `ConversationRoot` 之内，而非 details 列或自建 slot：details slot 单占用且由选中驱动（生命周期不同于一条常开横条），且 slot 表没有为 plan 预留席位。组件 props 完备且框架无关，因此日后迁往专用 slot 不触及其内部任何东西。

### TodoRow：经 keyed toolview slot 的逐调用行

专用的 `todo_write` 对话行是一个普通注册者插件（`todoToolview`，由 `apply` 挂载），经 `ctx.slots.register` 注册进 keyed 的 `conversation.chat.toolview` slot——与 bash 样例同一接缝、同一载序姿态（`inject: ['slots', 'conversation']`），但属产品级注册。摘要由调用 args 推导（`N/M done · active item`）；无法解析的 args 回退到通用行摘要；点击会以原始 args 打开 details 列。todo 不新增任何 `ToolEventView`——呈现归客户端所有，常驻列表从会话事件渲染，而非工具卡。

## Alternatives considered

- **把 todo 写入作为 surface 条目折叠进 `nodes`**——回放的窗口会渲染每一份已被取代的列表；该事件被刻意设计成非 surface 类型。
- **面板放进 details 列或专用 slot**——details slot 单占用且由选中驱动；新增一个 slot 键需要一个 slot 表席位，而设计尚未分配。面板框架无关，所以真要迁移，代价依然很低。
- **host 计算的视图（一个 todo `ToolEventView`）**——呈现属于客户端；协议已在事件载荷里携带整份快照。

## Consequences

回放正确性由一条代码路径掌管：未来对窗口重建的任何改动都免费保持 todos 一致；fx-alpha 第 63 轮的 fixture（测试前置数据）加 `scripts/verify-todo-display.mjs` 在真实 chromium 里钉住整条链（面板可见性、行摘要、详情联动、折叠、深色主题）。`todos` 是 `ConversationSnapshot` 的必填字段，所以 spec 里脚本化的 fake 必须带上它。ACP 桥接的 todo → `plan` 映射与 TUI 面板均未受改动；Web 各面渲染同一个事件，不引入任何新的协议词汇。冷加载重建由 host 兜底：history 尾页附带 `todos`——全量 log 上最新一次 `todo/write` 的投影，独立于分页窗口计算（与 view 配对同一种 backscan 姿势）——因此重开会话时即使最后一次写入落在窗口之前，计划也照常恢复；播种值跨窗口重建保留，之后的任何写入照常覆盖。
