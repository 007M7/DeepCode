# RFC: Interception seams — the typed-Decision surface a hook programs against

Status: implemented (accepted 2026-06-30)

<!-- XXX: legacy ADR/RFC body format, not yet normalized to a unified RFC template. -->

## Context

The harness needs a hooks subsystem: users extend or gate the agent at lifecycle points the way Claude Code (CC) and Codex do. The key reframe driving this design is that **"native hooks" are not a package** — a native hook is just an ordinary Cordis plugin subscribing to the canonical lifecycle events. So the real product is a *powerful, well-typed canonical event surface*; the CC/Codex bridges (the `dsh-hooks-claude` / `dsh-hooks-codex` packages) are merely translators that map an external shell-hook protocol onto that same surface. Anything a bridge can do, a plain plugin can do directly — more powerfully (no serialization boundary, full `ctx`, typed returns).

Before this change the interception surface was incomplete and inconsistent for that goal: there was no per-prompt seam (CC's `UserPromptSubmit`), no session-start signal (CC's `SessionStart`), the single `tools/execute` waterfall conflated the pre-gate and post-inspect phases (CC splits `PreToolUse`/`PostToolUse`), and `agent/turn-continuation` returned a bare `boolean` with no room for a force-continue *reason*. The [event-domain-semantics RFC](../architecture/2026-06-30-event-domain-semantics.md) pinned down the three-domain rule and the typed-Decision idiom as the interception convention; this RFC builds the actual seams on top of it.

## Decision

Add/​reshape the interception seams so every one returns a small, seam-specific **typed Decision union**, and the set covers the hook points in scope (`session-start`, `prompt-submit`, `pre-tool`, `post-tool`, `stop`-via-continuation).

**New `agent/*` events** (`dsh-agent`):
- `agent/session-start(agent, source)` — emit, once before turn 1, carrying a `SessionStartSource` (`startup` for a fresh/forked create, `resume` for a reloaded persisted session; `clear`/`compact` reserved). A pure notification — it CANNOT block startup (a deliberate gap: a bridge logs/injects, it does not gate startup). A listener seeds context via `agent.inject()`.
- `agent/prompt-submit(agent, content, source, next) → PromptDecision` — waterfall, fired per drained queued message inside the open turn, before the `user/message` append. `allow` (optionally rewriting the prompt `content` or attaching `additionalContext`) or `block` (dropping the prompt; the loop appends a durable `prompt/blocked` in its place — see the dispatch note below).

**Reshaped** `agent/turn-continuation` from `(…, defaultDecision: boolean) → boolean` to `(…, defaultDecision: ContinuationDecision) → ContinuationDecision`. A `{action:'continue', reason?}` may carry model-facing context recorded as next-step steering in the same turn — the typed twin of the existing `/goal` step-end-steer pattern.

**Split** the single `tools/execute` waterfall into `tools/pre-execute` (→ `PreToolDecision` allow/deny/ask gate) and `tools/post-execute` (→ `PostToolDecision` accept/block, optionally replacing content or attaching `additionalContext`). Core dispatch sits between them as plain code inside `ToolRegistry.execute`'s outer try/catch, and the tool body keeps its own inner try/catch so a thrown tool still becomes an `isError` result that `post-execute` listeners can inspect.

**New `TurnEndReason` variant** `rejected` (`dsh-session`): a turn whose entire prompt batch was blocked by `prompt-submit`.

### Three load-bearing loop decisions

1. **Always open the turn first; a fully-blocked batch is a zero-step `rejected` turn; every veto is recorded as `prompt/blocked`.** `prompt-submit` fires AFTER `turn/start`, per message. A batch whose every prompt is blocked does NOT skip the turn — it opens a zero-step turn that closes with `rejected`. This one move resolves three problems at once: (1) turn-enclosure holds (every event has an open turn to live in); (2) the durable `turn/end` is appended and the ACP bridge settles normally off it (mapping `rejected`→`cancelled`) instead of hanging; (3) the block reason is a durable in-turn fact. Independently, each individual veto appends a `prompt/blocked` session event (the original `content`, `source`, and `reason`) in place of the `user/message` the prompt would have become — necessary because a MIXED batch (one prompt blocked, another allowed) does NOT end `rejected`, so the boundary reason alone would silently lose the blocked prompt on replay. An `allow`'s `additionalContext` is `inject()`ed into this now-open turn.

2. **Post-tool `additionalContext` is buffered and appended AFTER all `tool/result`s.** `content`/`feedback` shape the result `execute()` returns, but `additionalContext` is a SEPARATE `context/message`, and a single step can carry multiple tool calls. Appending context right after each result would interleave `result(c1) → context → result(c2)` and break tool-call/result adjacency. So `execute()` surfaces `additionalContext` on its `ToolExecutionResult`, and the loop buffers every per-call context for the step and appends them as `context/message`(s) only after every `tool/result` is appended.

3. **A forced `continue` `reason` is enqueued through the steering channel**, so the next step's top-of-loop drain records it as steering for the continued turn — next-*step* steering within the SAME turn, not a next-*turn* prompt (matching the existing `hasSteering` force-continue override).

### Pre-tool INPUT rewrite is DEFERRED (the over-reach signal)

`PreToolDecision` is allow/deny/ask only — **no `arguments` rewrite**. Output replacement (`PostToolDecision.accept.content`) is safe because `tool/result` is logged AFTER execution (one source of truth). Input rewrite is NOT safe today: `assistant/message` (the model-history source) and `tool/call` (the audit record) are both logged BEFORE execution, and live consumers READ `tool/call.arguments` for presentation (the ACP bridge remembers them for `presentResult`; `dsh-tool-bash` derives the title/cwd/terminal-vs-background from them). A rewrite that changed only execution would make the UI show one command while another RAN. Designing that consistently (rewriting the audit + history + presentation as one unit) is a real consistency-design problem CC itself warns is racy — so it gets its own [proposed RFC](../../proposed/feature/2026-06-30-pre-tool-input-rewrite.md), and `TODO(pre-tool-input-rewrite)` anchors it at the loop's pre-execute call site. This does not regress any production consumer (no production `tools/execute` listener mutated `exec.arguments`). The low-level capability to mutate `exec` in a `pre-execute` listener still exists (unadvertised — a test shim uses it to thread a generated id), but it is not a first-class advertised contract.

### What this PR does NOT do

It does **not** declare `hook/*` SessionEvents (the durable hook-invocation log) — those belong to the `dsh-hook-protocol` library, because a native plugin can already use the typed Decisions without a durable hook log. A worked native-plugin example/test in this PR (`packages/core/agent-loop/tests/interception.spec.ts`) proves all the seams compose end-to-end through the REAL loop with NO `hook/*` involved — the concrete proof that "native hooks are just a plugin". Compaction (`PreCompact`/`PostCompact`), the Notification hook, Codex `PermissionRequest`, the permission/`ask` system, and the Stop loop-guard remain deferred (`FIXME(permissions)` marks the `ask`→deny degrade).

## Consequences

The canonical interception surface is now complete and uniformly typed: a native plugin returns typed decisions directly, and a CC/Codex bridge maps its protocol fields onto the same unions. The loop gained four firing points (session-start emit, prompt-submit waterfall, the post-tool context buffer, the continuation reshape) and the `dsh-tools` registry runs a two-waterfall pipeline; both are documented in [architecture.md](../../../architecture.md) and the package READMEs, and the decision types in [core-data-structures](../../../core-data-structures/core.md#interception-decisions) + [tools.md](../../../core-data-structures/tools.md). All existing `tools/execute` and `turn-continuation` listeners (tests, docs) migrated to the new seams. The ACP bridge maps the new `rejected` reason to `cancelled` (its codec). A pure internal change with no editor-visible transcript shift for the existing scenarios — the new behavior only fires when a hook is registered — so the snapshot goldens are unchanged; a hook-driven snapshot scenario lands with the `dsh-hooks-claude` bridge, which is what makes a hook observable end-to-end through ACP.
