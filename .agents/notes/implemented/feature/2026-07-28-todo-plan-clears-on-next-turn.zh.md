# Agent Note: Todo 计划条在下一轮 turn 开始时清空

Status: implemented

[English](2026-07-28-todo-plan-clears-on-next-turn.md) | 中文

## Problem

`todo_write` 把整份列表快照写在会话日志上，交互式宿主把最新列表渲染为计划条（web TodoPanel、TUI Plan 面板）。一轮结束后，该条会一直留到下一个用户 turn——上一任务已完成或已放弃的清单仍挂在界面上。读者把计划条理解成「本轮在做什么」，因此跨 turn 边界的陈旧列表是错误的产品生命周期。[web todo 展示](2026-07-23-web-todo-display.md) 与 [`todo_write` 工具](2026-06-29-todo-write-tool.md) 两份 Note 仍拥有事件溯源与两个渲染面；它们曾把站立计划描述为整段会话持续到下一次写入。

## Decision

站立计划是「其后没有更晚 `turn/start`」的最近一次 `todo/write`。`turn/end` 仍保留列表，便于用户阅读刚结束的回答时对照已完成清单；下一个 `turn/start` 将其清空，直到模型再次写入。

### 实时路径

Web 的 `Session.applyEventSideEffects` 与 TUI 的 `renderEvent` 开关在 `turn/start` 清空计划条，在 `todo/write` 替换它。TUI 重建路径在回放日志前复位面板，使冷恢复收敛到同一规则。

### 冷加载 / history 投影

Host 的 `backscanTodos`（以及 fixture 平行实现）从日志尾部向前扫描：先遇到 `turn/start` 表示没有站立计划；先遇到 `todo/write` 即为站立列表。尾页 `session.history` 仍携带该投影（空则省略）。客户端重建从空计划扫过窗口，仅当窗口本身从未判定计划（无 `todo/write` 且无 `turn/start`）时恢复尾页种子；连续尾窗口若含写入之后的 `turn/start` 则判定为空，与 host 一致。

## Alternatives considered

- **在 `turn/end` 清空**——用户仍在阅读刚完成的回答时清单消失；此时计划条的职责正是展示完成态，而非空 dock。
- **仅在全部 `completed` 时清空**——未完成或中途放弃的计划仍会跨 turn 残留；计划条会继续展示另一任务的工作。
- **在 turn 开始时追加空的 `todo/write`**——为 UI 生命周期规则改写日志，并捏造模型从未写出的写入。

## Consequences

交互式宿主与 history 投影共用同一生命周期规则；重开会话仅在其后没有更新的 turn 启动时恢复计划。对 [web todo 展示](2026-07-23-web-todo-display.md) 与 [`todo_write` 工具](2026-06-29-todo-write-tool.md) 中「会话级站立计划」表述构成部分取代：事件溯源、后写覆盖与两个渲染面仍归那两份 Note；本 Note 拥有 turn 边界清空。覆盖：客户端 session 对实时清空 + 回放为空的用例、host 在写入后的 `turn/start` 之后的 history 投影，以及既有的 web todo-display 快照（fixture 第 65 轮仍是日志末端，计划条仍被钉住）。
