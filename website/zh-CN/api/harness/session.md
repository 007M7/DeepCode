# Session (dsh-session)

会话事件流管理。

**包名:** `@deepseek-ai/dsh-session`
**服务名:** `ctx.session`

## 概述

Session 是 Agent 的对话状态容器。所有模型可见的内容都必须经过 session 事件流记录——这是"model-visible = logged"原则的实现。

## SessionSurface

会话的外部接口，用于查询当前状态。

### surface.messages

- **类型:** `Message[]`

当前会话的完整消息列表（经过 compaction 处理后的视图）。

### surface.events

- **类型:** `SessionEvent[]`

原始事件流。

## SessionEvent

会话中所有变更以事件形式记录：

```typescript
type SessionEvent =
  | { type: 'user/message'; content: ContentBlock[] }
  | { type: 'assistant/message'; content: ContentBlock[] }
  | { type: 'tool/call'; name: string; args: unknown; callId: CallId }
  | { type: 'tool/result'; callId: CallId; content: ContentBlock[]; isError?: boolean }
  | { type: 'compact/start'; range: [number, number] }
  | { type: 'compact/end'; summary: string }
  | { type: 'todo/write'; items: TodoItem[] }
  // ... 更多事件类型
```

## 设计原则

### Model-visible = Logged

任何到达模型请求的内容都必须能从 session log 重建。如果你要引入新的模型可见输入，必须先定义对应的 session event。

### 事件是 append-only

Session 事件流是只追加的。修改历史（如 compaction）通过新事件（compact/start + compact/end）表达，而不是修改旧事件。

### 持久化

Session 事件流可以通过 `dsh-session-persistence` 持久化到磁盘（JSONL 或 SQLite），实现跨进程恢复。
