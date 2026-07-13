# RFC: Interception seams — the typed-Decision surface a hook programs against

Status: implemented

## Problem

The harness needs a hooks subsystem: users extend or gate the agent at lifecycle points the way Claude Code (CC) and Codex do. The key reframe driving this design is that **"native hooks" are not a package** — a native hook is just an ordinary Cordis plugin subscribing to the canonical lifecycle events. So the real product is a *powerful, well-typed canonical event surface*; the CC/Codex bridges (the `dsh-hooks-claude` / `dsh-hooks-codex` packages) are merely translators that map an external shell-hook protocol onto that same surface. Anything a bridge can do, a plain plugin can do directly — more powerfully (no serialization boundary, full `ctx`, typed returns).

The surface needs distinct contracts for per-prompt policy (CC's `UserPromptSubmit`), session-start observation (CC's `SessionStart`), pre-tool policy, around-dispatch control, post-tool transformation, final-result observation, and continuation with a model-facing reason. Conflating those phases gives plugins mutation channels they do not need and makes finality depend on listener ordering. The [event-domain-semantics RFC](../architecture/2026-06-30-event-domain-semantics.md) supplies the three-domain rule and the typed-Decision idiom; this RFC applies them to the lifecycle seams.

## Decision

The canonical surface separates transformable policy, around-dispatch control, and observe-only notification. Policy waterfalls return small seam-specific **typed Decision unions**; wrappers return normalized results; notifications receive immutable snapshots and cannot affect the outcome. The set covers the hook points in scope (`session-start`, `prompt-submit`, `pre-tool`, `post-tool`, `stop`-via-continuation) while leaving non-hook execution policy independently composable.

**Agent events** (`dsh-agent`):
- `agent/session-start(agent, source)` — emit, once before turn 1, carrying a `SessionStartSource` (`startup` for a fresh/forked create, `resume` for a reloaded persisted session; `clear`/`compact` reserved). A pure notification — it CANNOT block startup (a deliberate gap: a bridge logs/injects, it does not gate startup). A listener seeds context via `agent.inject()`.
- `agent/prompt-submit(agent, content, source, next) → PromptDecision` — waterfall, fired per drained queued message inside the open turn, before the `user/message` append. `allow` (optionally rewriting the prompt `content` or attaching `additionalContext`) or `block` (dropping the prompt; the loop appends a durable `prompt/blocked` in its place — see the dispatch note below).

**`agent/turn-continuation`** receives and returns a `ContinuationDecision`. A `{action:'continue', reason?}` may carry model-facing context recorded as next-step steering in the same turn — the typed twin of the `/goal` step-end-steer pattern.

### The tool pipeline gives each phase one kind of authority

Every call follows one ordered pipeline: `tools/pre-execute` → monotonic guards → `tools/execute` → core dispatch → `tools/post-execute` → `tools/result`. The registry reads each caller-owned input field once, materializes `arguments` as detached lossless JSON in one recursive pass, and snapshots `ToolExecutionInput` into a pipeline execution with its own opaque token. Identity fields and deeply frozen arguments are immutable for the whole pipeline, and a nested call's `parent` contains only the enclosing execution's token rather than its live object. Optional `signal` is the only operational field an around-dispatch wrapper may add, replace, or remove, and the complete object freezes before final observers run. This identity contract prevents a policy listener from silently changing what the log, UI, and tool body believe ran.

- **`tools/pre-execute`** is the extensible waterfall gate. Its `PreToolDecision` allows, denies, or asks. Deny skips `tools/execute` and core dispatch. Ask resolves through the optional approval seam: only `allowed-once` continues through guards and dispatch; rejection, cancellation, an unavailable channel, a missing approval service, or an agent-less call becomes a normalized denial. Every outcome still reaches post-policy and final observers.
- **`ctx.tools.guard()`** installs synchronous scope-aware policy after the whole pre-execute waterfall. A guard may deny or abstain, never force-allow, so listener ordering cannot resurrect an operation that a final invariant forbids.
- **`tools/execute`** is the around-dispatch waterfall for timeout, retry, and metrics plugins. A wrapper delegates to core dispatch with `next()`, may add, replace, or remove only `exec.signal` before doing so, and receives the already-normalized result of a thrown or unknown tool; returning its own valid result short-circuits dispatch.
- **`tools/post-execute`** is the inspect/transform waterfall. Its `PostToolDecision` accepts, blocks with feedback, optionally replaces content, or attaches `additionalContext`; in-place mutation of the result is not a transform channel, because the registry rebuilds the outcome from a protected snapshot plus the returned decision.
- **`tools/result`** is the synchronous contained notification after every transform, lossless-JSON materialization, and the outer error boundary. It receives the same frozen execution identity and an immutable snapshot of the authoritative result; observer failures are contained per listener and cannot change or reject `ToolRegistry.execute()`'s returned outcome.

Core dispatch and the tool body sit inside normalization boundaries, so tool, listener, malformed-result, non-JSON result, and identity-shape failures resolve as JSON-safe `isError` results rather than escaping the turn. A post-execute listener can therefore inspect a thrown tool, and a final observer sees exactly what the caller receives and the session log can persist.

**`TurnEndReason.rejected`** (`dsh-session`): a turn whose entire prompt batch was blocked by `prompt-submit`.

### Three load-bearing loop decisions

1. **Always open the turn first; a fully-blocked batch is a zero-step `rejected` turn; every veto is recorded as `prompt/blocked`.** `prompt-submit` fires AFTER `turn/start`, per message. A batch whose every prompt is blocked does NOT skip the turn — it opens a zero-step turn that closes with `rejected`. This one move resolves three problems at once: (1) turn-enclosure holds (every event has an open turn to live in); (2) the durable `turn/end` is appended and the ACP bridge settles normally off it (mapping `rejected`→`cancelled`) instead of hanging; (3) the block reason is a durable in-turn fact. Independently, each individual veto appends a `prompt/blocked` session event (the original `content`, `source`, and `reason`) in place of the `user/message` the prompt would have become — necessary because a MIXED batch (one prompt blocked, another allowed) does NOT end `rejected`, so the boundary reason alone would silently lose the blocked prompt on replay. An `allow`'s `additionalContext` is `inject()`ed into this now-open turn.

2. **Post-tool `additionalContext` is buffered and appended AFTER all `tool/result`s.** `content`/`feedback` shape the result `execute()` returns, but `additionalContext` is a SEPARATE `context/message`, and a single step can carry multiple tool calls. Appending context right after each result would interleave `result(c1) → context → result(c2)` and break tool-call/result adjacency. So `execute()` surfaces `additionalContext` on its `ToolExecutionResult`, and the loop buffers every per-call context for the step and appends them as `context/message`(s) only after every `tool/result` is appended.

3. **A forced `continue` `reason` is enqueued through the steering channel**, so the next step's top-of-loop drain records it as steering for the continued turn — next-*step* steering within the SAME turn, not a next-*turn* prompt (matching the existing `hasSteering` force-continue override).

### Pre-tool input rewrite is a separate consistency decision

`PreToolDecision` is allow/deny/ask only — **no `arguments` rewrite**. Output replacement is safe because `tool/result` is logged after execution from the final result. Input rewrite is different: `assistant/message` (model history) and `tool/call` (the audit record) are logged before `ToolRegistry.execute()`, while ACP and tool presentation read those arguments. The registry therefore seals the materialized arguments before `tools/pre-execute`; no listener or test shim can mutate them in place. An honest rewrite must update history, audit, presentation, and execution as one unit before that identity is created, which belongs to the separate [pre-tool input-rewrite proposal](../../proposed/feature/2026-06-30-pre-tool-input-rewrite.md) and its loop-side `TODO(pre-tool-input-rewrite)`.

### Boundaries

The seam package does **not** declare `hook/*` session events (the durable hook-invocation log); those belong to `dsh-hook-protocol`, because a native plugin uses typed decisions without an external hook log. The native-plugin integration test (`packages/core/agent-loop/tests/interception.spec.ts`) composes the seams through the real loop with no `hook/*` protocol. Compaction (`PreCompact`/`PostCompact`), Notification, and Codex `PermissionRequest` remain outside this decision. The [approval seam](2026-07-06-approval-seam.md) resolves `ask` decisions through `ctx.approval`, while terminal monotonic stopping is owned separately by `agent/turn-stop`.

## Alternatives considered

- **Shipping pre-tool INPUT rewrite as part of this seam set** — deferred as the over-reach signal; the section above carries the consistency problem (audit, history, and presentation all read `tool/call.arguments` logged before execution), and [the pre-tool input-rewrite proposal](../../proposed/feature/2026-06-30-pre-tool-input-rewrite.md) owns the design.
- **Declaring the durable `hook/*` SessionEvents alongside the seams** — rejected: a native plugin uses the typed Decisions with no hook log at all (the worked example proves it), so the durable log belongs to [the hook-protocol library](2026-06-30-hook-protocol-lib.md), not the seam surface.

## Consequences

The canonical interception surface is uniformly typed without giving every extension the same power: hooks return decisions, execution wrappers wrap, terminal guards only deny, and final observers only observe. The loop owns session-start, prompt-submit, post-tool context buffering, and continuation; `dsh-tools` owns identity sealing and the five-phase execution pipeline. Their contracts are documented in [architecture.md](../../../architecture.md), package READMEs, [core interception decisions](../../../core-data-structures/core.md#interception-decisions), and [tool structures](../../../core-data-structures/tools.md). The ACP bridge maps `rejected` turns to its `cancelled` codec value, while hook-driven snapshots verify the observable bridge behavior end to end.
