# Session Query

[English](session-query.md) | 中文

对实时优先的逻辑会话语料库进行精确读取。[包（package）契约](../../packages/session-query/session-query)定义了源优先级、动态可选持久化、克隆、surface 分类、有界窗口与类型化错误。全文搜索是另一个拟议的 SQLite 阶段。

源码：[`packages/session-query/session-query/src/types.ts`](../../packages/session-query/session-query/src/types.ts)

## 逻辑记录

`SessionRecord` 由跨语料库列表返回。它独立于克隆后的实时优先 header 暴露源可用性。`SessionEventRecord` 是轻量的原始日志投影；分类使用与 model-history 推导相同的 `foldSurface()` 状态转换。

```ts type-equiv
export type SessionEventSurface = 'current' | 'shadowed' | 'log-only'
```

```ts type-equiv
export interface SessionRecord {
  header: SessionHeader
  live: boolean
  persisted: boolean
}
```

```ts type-equiv
export interface SessionEventRecord {
  sessionId: SessionId
  seq: number
  type: SessionEventType
  time: number
  surface: SessionEventSurface
}
```

## 有界事件读取

请求指定一个原始 seq 及可选的邻近数量。结果携带 `SessionHeader` 而非可用性标志，使已知的实时目标可以独立于持久化健康状态。

```ts type-equiv
export interface SessionEventReadRequest {
  sessionId: SessionId
  seq: number
  before?: number
  after?: number
}
```

```ts type-equiv
export interface SessionEventWindow {
  session: SessionHeader
  target: SessionEvent
  events: SessionEvent[]
  startSeq: number
  endSeq: number
}
```

## 错误

封闭的 code 联合类型区分请求校验、目标缺失、surface 日志格式错误、可选后端故障与矛盾的源元数据。

```ts type-equiv
export type SessionQueryErrorCode =
  | 'SESSION_QUERY_EVENT_NOT_FOUND'
  | 'SESSION_QUERY_INVALID_CONFIG'
  | 'SESSION_QUERY_INVALID_SURFACE'
  | 'SESSION_QUERY_INVALID_WINDOW'
  | 'SESSION_QUERY_PERSISTENCE_FAILED'
  | 'SESSION_QUERY_SESSION_NOT_FOUND'
  | 'SESSION_QUERY_SOURCE_CONFLICT'
```
