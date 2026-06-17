# RFC: Microkernel — extension via Cordis event taxonomy, one concrete loop

Status: implemented (accepted 2026-06-11)

<!-- XXX: legacy ADR/RFC body format, not yet normalized to a unified RFC template. -->

## Context

The product principle (see the 微内核Harness实现思路 design doc) is "everything is a plugin": hooks, /goal, /loop, dynamic workflows, compaction, sandboxing, permissions, UI, persistence, MCP, skills must all be writable as plugins without modifying the core. Candidate mechanisms considered: a purpose-built middleware stack (koa-compose style), an explicit phase state machine plugins can insert into, or Cordis's native event system.

## Decision

Pure Cordis event taxonomy. The loop's extension seams are typed events with deliberate dispatch modes:

- **waterfall** (around-middleware) where plugins mutate or veto: `agent/request`, `agent/step-result`, `agent/turn-continuation`, `tools/execute`, `llm/stream`, `llm/generate`, `system-prompt/assemble`.
- **emit** (sync fire-and-forget) for notifications: turn/step boundaries, stream chunks, lifecycle, errors.
- **parallel** (awaited) for the one durability checkpoint: `session/flush`.

The event vocabulary lives in interface packages (dsh-agent declares the agent/* events); `@deepseek-ai/dsh-agent-loop` is the only concrete plugin and is itself swappable — nothing outside it may depend on it.

## Consequences

- Every MVP feature maps to a listener (the "plugin sanity checklist" in docs/architecture.md is the proof obligation, kept current).
- HMR and disposal come free: listeners and registrations are Cordis effects.
- Waterfall semantics (call `next()` or short-circuit) are non-obvious and must be taught — documented in AGENTS.md and covered by composition tests.
- The loop must be defensive: plugin exceptions are contained at turn level, steering from any seam is never stranded (regression-tested).
