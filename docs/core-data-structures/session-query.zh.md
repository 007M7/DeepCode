# Session Query

[English](session-query.md) | 中文

对优先使用 live 数据的逻辑 session 集合执行精确读取与关系追踪。[包契约](../../packages/session-query/session-query)拥有来源优先级、动态可选持久化、克隆、surface 分类、有界窗口、追踪校验与类型化失败。全文搜索属于另一个拟议的 SQLite 包。

源码：[`packages/session-query/session-query/src/types.ts`](../../packages/session-query/session-query/src/types.ts)

## 逻辑记录

`SessionRecord` 由跨语料库列表返回。它独立于克隆后的实时优先 header 暴露源可用性。`SessionEventRecord` 是轻量的原始日志投影；分类使用与 model-history 推导相同的 `foldSurface()` 状态转换。

```ts type-equiv
/** Whether an event is current model context, replaced context, or raw-log-only. */
type SessionEventSurface = 'current' | 'shadowed' | 'log-only'
```

```ts type-equiv
/** Lightweight identity and source availability for one logical session. */
interface SessionRecord {
  /** Cloned session header selected from the live-preferred corpus. */
  header: SessionHeader
  /** Whether the id currently exists in `ctx.sessions`. */
  live: boolean
  /** Whether the active persistence backend currently materializes the id. */
  persisted: boolean
}
```

`SessionSurfaceSnapshot` 表示一次精确读取所得的观测，而不是持续保留的订阅。它的原始日志边界与折叠后的事件来自同一次优先使用 live 数据的加载。

```ts type-equiv
/** One atomic live-preferred observation of a session's current model surface. */
interface SessionSurfaceSnapshot {
  /** Cloned session header selected from the same corpus observation as `events`. */
  session: SessionHeader
  /** Highest raw-log seq included in the observation, or `null` for an empty log. */
  capturedThroughSeq: number | null
  /** Cloned current surface events in model-history order. */
  events: SurfaceEvent[]
}
```

```ts type-equiv
/** Lightweight metadata for one event within a logical session. */
interface SessionEventRecord {
  /** Session that owns the event. */
  sessionId: SessionId
  /** Monotonic event seq within the session. */
  seq: number
  /** Discriminant of the session event. */
  type: SessionEventType
  /** Event timestamp in Unix epoch milliseconds. */
  time: number
  /** Event placement in the folded session surface. */
  surface: SessionEventSurface
}
```

## Session 谱系

`SessionLineageTrace` 按由近及远的顺序携带已知 parent，并携带一片由直接 descendant 递归嵌套而成的森林。完整性判别字段使已知 root 与缺失 parent 互斥。

```ts type-equiv
/** Recursive descendant node in a session-lineage trace. */
interface SessionLineageNode {
  /** Detached logical-corpus record for this descendant. */
  session: SessionRecord
  /** Direct children, each carrying its own recursive descendants. */
  descendants: SessionLineageNode[]
}
```

```ts type-equiv
/** Known ancestry and descendants for one logical session. */
type SessionLineageTrace = {
  /** Detached record for the session that was traced. */
  target: SessionRecord
  /** Known parents from the immediate parent outward. */
  ancestors: SessionRecord[]
  /** Complete known descendant trees rooted at the target's direct children. */
  descendants: SessionLineageNode[]
} & (
  | {
    /** The complete parent chain is present in the logical corpus. */
    complete: true
    /** Detached record at the top of the complete lineage. */
    root: SessionRecord
  }
  | {
    /** The parent chain leaves the visible logical corpus. */
    complete: false
    /** First parent id that is not present in the logical corpus. */
    unresolvedParentId: SessionId
  }
)
```

## 有界事件读取

请求指定一个原始 seq 及可选的邻近数量。结果携带 `SessionHeader` 而非可用性标志，使已知的实时目标可以独立于持久化健康状态。

```ts type-equiv
/** Request for one event plus raw neighboring log context. */
interface SessionEventReadRequest {
  /** Session that owns the target event. */
  sessionId: SessionId
  /** Target event seq. */
  seq: number
  /** Number of preceding raw events to include. */
  before?: number
  /** Number of following raw events to include. */
  after?: number
}
```

```ts type-equiv
/** Full target event and a bounded raw-log window. */
interface SessionEventWindow {
  /** Cloned header for the live-preferred source read. */
  session: SessionHeader
  /** Full cloned target event. */
  target: SessionEvent
  /** Full cloned events from `startSeq` through `endSeq`. */
  events: SessionEvent[]
  /** First seq included in `events`. */
  startSeq: number
  /** Last seq included in `events`. */
  endSeq: number
}
```

## 事件关系

事件追踪会区分位置性的 surface 替换与已记录 provenance。除 `replacementChain` 外，每个 seq 列表都包含直接链接；该链从目标沿直接 replacer 追踪到最终的位置替换。

```ts type-equiv
/** Request for direct surface and provenance relationships around one event. */
interface SessionEventTraceRequest {
  /** Session that owns the target event. */
  sessionId: SessionId
  /** Target event seq. */
  seq: number
}
```

```ts type-equiv
/** Direct surface and provenance relationships for one event. */
interface SessionEventTrace {
  /** Lightweight target record. */
  target: SessionEventRecord
  /** Immediate positional replacement event, when the target was shadowed. */
  replacedBy?: number
  /** Positional replacers from the immediate replacement to the final replacement. */
  replacementChain: number[]
  /** Surface nodes directly removed when the target itself performed a replacement. */
  replacedEventSeqs: number[]
  /** Direct logged provenance sources in their recorded order. */
  sourceEventSeqs: number[]
  /** Later events that directly name the target as a provenance source, in log order. */
  derivedEventSeqs: number[]
}
```

## 错误

封闭的 code 联合类型区分请求校验、目标缺失、surface 日志格式错误、可选后端故障与矛盾的源元数据。

```ts type-equiv
/** Stable machine-routable failure taxonomy for exact session reads and traces. */
type SessionQueryErrorCode =
  | 'SESSION_QUERY_EVENT_NOT_FOUND'
  | 'SESSION_QUERY_INVALID_CONFIG'
  | 'SESSION_QUERY_INVALID_LINEAGE'
  | 'SESSION_QUERY_INVALID_SURFACE'
  | 'SESSION_QUERY_INVALID_WINDOW'
  | 'SESSION_QUERY_PERSISTENCE_FAILED'
  | 'SESSION_QUERY_SESSION_NOT_FOUND'
  | 'SESSION_QUERY_SOURCE_CONFLICT'
```
