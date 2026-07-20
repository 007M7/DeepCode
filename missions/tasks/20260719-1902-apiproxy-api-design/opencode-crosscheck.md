# opencode 调研 × 本设计 对照（2026-07-19 19:10）

> 调研证据：`../20260719-1902-opencode-api-research/findings.md`（19 处 file:line）。

| 维度 | opencode 实际做法 | 本设计（design.md） | 判断 |
|---|---|---|---|
| 同构面 | 确认是 fetch：server 导出不监听的 `app`，进程内直接把 `app.fetch` 传给 SDK；TUI（现为 TS+solid，Go 版已删）在 Bun Worker 里跑 server，fetch 序列化走 Worker RPC，worker 端还原 Request 再 `app.fetch`；只有 `--port` 才真监听 | `createApiClient(toFetchHandler(api).fetch)` 进程内同构 | **同向，验证通过**。Worker RPC 案例额外证明：fetch 载体连线程边界都能过，Electron/TUI 形态无忧 |
| 命令流 | `prompt_async` 立即 204，渲染全由事件驱动（CQRS） | `prompt` 返回 `accepted:true`，UI 全靠 mux 事件 | **同向** |
| token 增量 | `message.part.delta` 走事件总线，不走 prompt 响应流 | `assistant/chunk` 透传走 mux | **同向** |
| 事件总线 | 全局单 SSE，事件带归属字段客户端过滤；**断线无 cursor，重连靠 REST 全量 bootstrap 重建 store** | v1 无 `since` 续传（签名留座），重连=重开流+重拉 history | **同向**。下方建议已采纳，见 design.md §0.7 |
| 类型打通 | server-first：Effect httpapi Schema → OpenAPI → codegen SDK | TS interface 权威 + 手写薄 client，zod 双向校验 | **有意不同，维持**：monorepo 内无外部 SDK 消费者，codegen 链是负资产；zod 承担了他们 Schema 的校验职责 |

## 建议（已采纳 → design.md §0.7）

**mux 重连可以再砍一刀**：v1 干脆不做 `since` cursor——重连 = 重开流 + 各打开的 session 重拉 `history()` 重建（opencode 全量 bootstrap 同款，且我们 history 本来就是事件重放，重建代价 = 一次分页请求）。`since` 字段在签名里保留为可选，实现留空。这同时消解了 design.md §7 开放问题 3（since 走 query 还是 POST）——v1 根本不传。

代价：重连瞬间 UI 重建（闪一下）+ 多拉一次历史窗口。localhost 场景断线本来罕见，可接受。
