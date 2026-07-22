# @deepseek-ai/dsh-pty

Owner-scoped persistent PTY seam. `PtyService` registers as `ctx.pty`, mints opaque session ids, routes creation through named backends, fences every operation to the exact live `Agent`, and awaits backend quiescence when that agent or the service disposes.

## Contract

- Backends register one stable `type` and return an unpublished `PtyBackendSession`; failed or cancelled setup must clean partial resources.
- A successful spawn publishes one `PtySessionId`. The optional `name` is owner-local display metadata, never authority.
- One session accepts at most one live send operation. Reads and signals may observe it; another send fails until the operation settles.
- `PtySendResult.waitReason` and `sessionStatus` are independent. `session_exit` describes the top-level PTY process, not an arbitrary foreground command.
- `kill()` and disposal resolve only after the backend's captured process tree is quiescent. A cleanup failure rejects instead of claiming success.

The seam contains no `node-pty`, sandbox, tool-schema, prompt, task, or terminal-rendering policy. Implementations own terminal mechanics; consumers own model presentation and optional background-task registration.

## Model Experience

### Indirect consumer

#### What the model sees

Nothing directly. This package registers no prompt or tool; `@deepseek-ai/dsh-tool-pty` owns visible schemas and result text.

#### Token effect

None directly. Live session state stays process-local until a consumer returns a bounded result.

#### KV Cache effect

No direct invalidation; the named consumer owns request-prefix changes.

## Known Limitations and Deferred Work

- Sessions are process-local and are not restored after a harness restart.
- Cross-agent sharing is intentionally absent; a future shared-session design needs a separate authority contract.
