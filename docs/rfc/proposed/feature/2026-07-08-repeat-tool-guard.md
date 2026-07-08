# RFC: Repeat-tool-call guard plugin

Status: proposed

## Problem

A model stuck in a loop re-issues the same tool call with byte-identical arguments — re-running a failing grep, re-reading an unchanged file, polling a command that already gave its answer — and each round trip burns tokens, wall-clock, and (for paid APIs) money without adding information. The harness has nothing that notices: the loop has no step budget, no plugin tracks call repetition, and the model only escapes when it happens to vary its own behavior. The failure mode is real and cheap to detect — [pi-repeat-tool-guard](https://github.com/Kingwl/pi-repeat-tool-guard) ships exactly this as a pi coding-agent extension: count consecutive identical calls and, past a threshold, append a `<system-reminder>` telling the model to stop repeating itself and change course.

The harness already has every seam the pi extension uses, and better ones: [the interception-seams RFC](../../implemented/feature/2026-06-30-interception-seams.md) gives `tools/post-execute` a sanctioned way to attach model-facing context to a finished call, the loop buffers and injects that context with call/result adjacency preserved, and injected context is a logged `context/message` — so a native guard satisfies the model-visible ⟺ logged rule with no new session event. What is missing is only the plugin itself.

## Proposal

The guard is a loop-hygiene plugin, not a model-facing tool: it never appears in the tool list, never vetoes or rewrites a call, and adds exactly one behavior — it watches each agent's stream of tool calls, counts runs of consecutive calls to the same tool with identical canonicalized arguments, and at configured run lengths injects an escalating advisory reminder telling the model to stop repeating itself, re-read the last result, and either change approach or conclude. The purpose is to break unproductive loops within a few wasted steps instead of letting them run to the turn's natural end — while leaving the decision (retry differently, gather more evidence, or finish) entirely with the model, so a legitimately repeated call is delayed by nothing and blocked by nothing.

The shape: one new leaf plugin package, `@deepseek-ai/dsh-repeat-tool-guard` at `packages/guard/repeat-tool-guard/`, opening a `guard/` group for loop-hygiene plugins (single-package groups have precedent: [the todo-write RFC](../../implemented/feature/2026-06-29-todo-write-tool.md) shipped `todo/tool-todo`). The plugin registers three listeners via `ctx.effect()` and holds all state in plugin-local maps keyed by `AgentId` — the tool registry is a context-level singleton whose waterfalls interleave every agent's calls (subagents run on the same context), so per-agent keying is correctness, not polish.

- **`tools/post-execute` (waterfall)** — the one detection point. The listener receives `(exec, result)` together, so counting and reminder delivery need no cross-event pending map (the pi extension needs one only because its `tool_call`/`tool_result` hooks are separate events). It always delegates via `next()` and, when a threshold is hit, folds a reminder onto the downstream decision's `additionalContext` — the observe-and-enrich posture [the hooks bridges](../../implemented/feature/2026-06-30-hook-bridges.md) already use, honoring the waterfall contract. Counting happens here rather than in `tools/pre-execute` because post-execute also runs for denied calls (`ToolRegistry.execute` routes a deny through the same pipeline), and a model hammering a denied call is exactly the loop worth breaking.
- **`agent/prompt-submit` (waterfall)** — pure reset hook: delegate via `next()`, clear the submitting agent's chain. A user interjection changes the context; repetition across it is not a loop.
- **`agent/status` (emit)** — on `disposed`, drop the agent's state, bounding the maps over harness lifetime.

### Detection semantics

The chain key is `(tool name, canonical arguments)`; a call identical to the previous tracked call increments the agent's consecutive counter, a different tracked call resets it to 1. Canonicalization is a deep key-sort plus `JSON.stringify`: `ToolExecution.arguments` is by construction the loop's `JSON.parse` output (or the raw string fallback for malformed argument JSON, which is itself a comparable value), so the pi original's bigint/circular/`undefined` handling has no inputs here and is deliberately dropped.

Two deliberate rules, both documented in the package README because they are behavior a reader would otherwise guess at:

- **Untracked calls are transparent to the chain.** A call excluded by `include`/`exclude` neither increments nor resets the counter, so `grep X → todo_write → grep X` still counts as two consecutive `grep X` when `todo_write` is excluded. This is what makes exclusion useful — bookkeeping tools interleaved into a loop must not launder it — and it is the pi extension's (undocumented) semantics, kept on purpose and written down.
- **Calls without an agent are ignored.** A direct `ctx.tools.execute()` caller (tests, future non-loop consumers) has no model to remind and no `AgentId` to key on.

### Reminder delivery

Reminders ride `additionalContext` (source `{kind: 'plugin', plugin: 'repeat-tool-guard'}` — the label is load-bearing per `HookContext`), never a `content` replacement: the `tool/result` event stays the tool's own output for audit, and the loop already appends buffered context as `context/message`(s) after the step's results, which the session renders as the tagged synthetic-user envelope and derived history replays. Thresholds escalate: the first configured threshold gets a short "you are repeating yourself, analyze the previous result" nudge; each later threshold gets the detailed form naming the tool, the repeat count, and the canonical arguments, and stating that the calls made no progress. The pi original hardcodes the gentle text to the literal count 3; the guard keys it to `thresholds[0]`, fixing that bug in the port. When the downstream decision already carries `additionalContext` (a hook bridge on the same call), the guard folds content following the shared-merge precedent in `dsh-hook-protocol`.

### Config

```yaml
- id: repeat-tool-guard
  name: '@deepseek-ai/dsh-repeat-tool-guard'
  config:
    thresholds: [3, 5, 8]   # default; consecutive counts that trigger a reminder
    include: []             # tool-name patterns to track; empty ⇒ all tools
    exclude: [todo_write]   # tool-name patterns transparent to the chain
```

`thresholds` is validated at load and throws on an empty list, a non-integer, a value below 2, or a duplicate — misconfiguration fails loud, replacing the pi original's silent fall-back to defaults. `include`/`exclude` entries support `*` wildcards. Patterns are predicates over whatever tools exist at call time, not references to a registry entry, so an entry matching no currently registered tool is NOT an error — unlike `toolOrder`'s referent check, `exclude: [mcp_*]` must stay valid in a deployment that loads no MCP tools.

### Testing

Coverage named at plan time, per tier: **unit** — counting/reset semantics (identical, different-tracked, untracked-transparent, prompt-submit reset, disposal cleanup, per-agent isolation), canonicalization, threshold escalation including the `thresholds[0]` gentle-text rule, config fail-loud cases, and the fold-onto-downstream-decision path, to per-file 100% like every `packages/*/*/src` file. **Snapshot** — one scripted-replay scenario where the model repeats a call to threshold and the reminder `context/message` appears in the transcript, pinning the model-visible text and its envelope (this is a transcript-surface change; the ACP snapshot suite is the tier that owns it). **e2e** — none: the plugin is provider-independent and deterministic, and forcing a live model to repeat a call three times is not a stable test; the seam contracts it relies on are already e2e-covered by their owners.

## Alternatives considered

- **Append the reminder into the tool result** (`accept` with replaced `content` — the pi extension's mechanism, which patches result content because that is the only channel its API offers) — rejected: it makes the logged `tool/result` lie about what the tool returned, and `additionalContext` exists precisely as the separate sanctioned channel for post-execute commentary, with loop-level buffering that preserves call/result adjacency.
- **Count in `tools/pre-execute` with a pending-reminder map** (the pi two-phase shape) — rejected: post-execute alone sees `(exec, result)` together and also fires for denied calls, so one listener with no cross-event state covers strictly more attempts with less machinery.
- **Escalate to `block` at the highest threshold** — rejected for the initial scope: a blocked call punishes legitimate identical repeats (polling a long-running terminal, re-checking a file the agent expects to change), and an advisory reminder keeps the model in control. Revisit with evidence; the decision shape (`PostToolDecision`) already supports it.
- **A per-deployment external hook via the CC/Codex bridges** (a `PostToolUse` script) — rejected as the answer: it works today for one deployment, but a shipped, unit-tested, `cordis.yml`-configurable plugin is the harness-native form, without per-call subprocess cost.
- **A loop-level step or repetition budget in `agent-loop`** — rejected: "plugins, not loop changes"; a hard step budget is a blunter, orthogonal control that would need its own proposal.
- **Fuzzy/near-identical detection** (normalized paths, similar-but-not-equal arguments) — rejected: exact match after canonicalization is cheap, deterministic, and explainable to the model; similarity thresholds invite false positives and need evidence before they earn complexity.
- **Placing the package in `core/`** — rejected: core is the product spine; a behavioral guard is an optional leaf plugin, and the `todo/` precedent is a small dedicated group per plugin family.

## Acceptance criteria

- `packages/guard/repeat-tool-guard/` exists, registers all listeners through `ctx.effect()`, and is loadable from a `cordis.yml` with the config above; the config catalog regenerates with its entry.
- Invalid `thresholds` (empty, non-integer, `< 2`, duplicate) throw at plugin load.
- Unit suite covers the semantics list above at per-file 100%; a snapshot scenario replays a threshold-crossing repetition and pins the reminder `context/message` in the transcript on macOS and Linux.
- The reminder is reconstructable from the session log alone (it is an ordinary `context/message` with a plugin source — no new session event).
- The package README opens with the plugin's purpose — an advisory loop-breaker that is not a model-facing tool, never blocks or rewrites a call, and only injects reminders — then documents the transparency rule, the per-agent keying, and the in-memory-only state; `doc-sync` is green.

## Risks

- **False positives on legitimately repeated calls.** Idempotent polling patterns repeat identical calls on purpose; the reminder is advisory and thresholds/`exclude` are the pressure valves, but a badly tuned deployment adds noise to the transcript. Mitigation: conservative defaults and the reminder text explicitly allowing "finish the task if enough evidence has been gathered".
- **Reminder tokens are model-visible cost.** Each trigger appends a paragraph to the next request; thresholds bound the frequency, but a pathological agent can hit 3/5/8 repeatedly across different keys.
- **State is in-memory only.** A session resumed from persistence starts with a fresh chain, so a loop spanning a resume gets its reminders later than a live one — accepted: the guard is a heuristic nudge, not a logged invariant, and persisting counter state would buy little for real complexity.
- **Multiple context producers on one call.** When a hook bridge and the guard both attach `additionalContext`, ordering follows listener registration order; the fold keeps both, but the combined envelope's readability depends on merge behavior that this RFC inherits rather than owns.

## Open questions

- Should compaction reset chains? A compacted history changes what the model sees, but the repetition risk usually survives compaction; the initial answer is no.
- Should subagents inherit the parent's thresholds via config only, or ever share chain state? Per-agent isolation is the proposed default; sharing looks like a smell until a concrete case appears.
