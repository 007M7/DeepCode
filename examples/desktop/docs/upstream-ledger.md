# Upstream ledger

Findings that need a fix in `deepseek-harness` upstream (not in this repo),
kept here so we don't lose them when we ship the desktop demo. Each entry is
a promise to file — either an RFC (via `docs/upstream-rfc-pack/`) or a
narrower PR. What lives in this repo is the local workaround; what lives
upstream is the proper fix.

Format per entry:

- **Symptom** — what a user sees today.
- **Root cause** — file:line pins into the upstream repo (path relative to
  `packages/…` in `deepseek-harness-dev/` or the corresponding org path in
  `deepseek-ai/deepseek-harness`).
- **Local workaround** — what we did in this repo to keep the demo honest,
  and how to spot the workaround at review time.
- **Upstream fix (needed)** — the shape of the correct change.

---

## L-1  Runtime should emit the presented view for tool results, not the raw `execute()` meta

**Symptom.** On the default profile (`stdio-deepseek`), the file-diff card
never renders after an `fs.edit` / `fs.write`. The tool executes, the result
box appears, but the visual diff (which is the headline for the "files
visualization" story) is missing. Same latent risk for the terminal card on
`bash`.

**Root cause.** Two layers in upstream never meet:

- `packages/fs/tool-fs/src/edit.ts:92-96` — `execute()` returns
  `{ content, meta: { diffs } }`. There is no `card` field on this meta.
- `packages/fs/tool-fs/src/edit.ts:111-116` — `presentResult()` is where
  the display view (`{ card: 'diff', title, diffs }`) is authored. This is a
  display-time callback.
- `packages/core/agent-loop/src/loop.ts:584-594` — the runtime persists the
  raw `execute()` meta verbatim on the `tool/result` event. `presentResult()`
  is never invoked; nothing on the wire ever gains a `card` discriminant.
- `packages/core/tools/src/index.ts:787-790` — the tool-registry side of the
  same seam; `presentResult()` is declared in the tool descriptor but has
  no runtime call site.

The desktop renderer's `tool/result` dispatch (this repo's
`src/renderer/renderer.js:4744`) primarily routes by `view.card === 'diff' |
'terminal' | 'widget'`. With no `card` on the wire, all fs meta falls
through to the raw-text fallback branch.

**Local workaround.** `src/renderer/renderer.js:4744` now has a fs-family
fallback: when `view.card` is absent, `view.diffs` is an array, and the
tool name is fs-family (`fs.edit` / `fs.write` / `fs.read`, or the
short-form aliases), it synthesises `{ card: 'diff', title, diffs }` and
renders through the same path. See test/`renderer-diff-card-fallback.test.js`
+ `test/fixtures/fs-edit-wire-shape.json` (the fixture is the real wire
shape captured on lane-showcase 2026-07-18 during the 12/12 verify).

Spot the workaround in code review by the `viewLooksLikeDiff` /
`isFsFamilyTool` locals in the `tool/result` case, and by the fixture
JSON's `_note` header.

**Upstream fix (needed).** Either

- Make `agent-loop` invoke `presentResult(args, result)` on `tool/result`
  emit and put the returned view onto the wire under `data.meta`, replacing
  (or supplementing) the raw `execute()` meta; OR
- Expose the tool registry to the shell so a shell-side dispatcher can call
  `presentResult` after receiving the raw meta.

Either shape is a small RFC (see `docs/upstream-rfc-pack/` template). The
tool-side contract (`presentResult` returning `ToolResultView`) already
exists — this is a wiring gap, not a design decision.

Once upstream lands the fix, the fallback becomes dead code but stays in
place (the shape test still passes via the primary `card:'diff'` branch),
so there's no coupling between land order.

---

<!--
  Future entries append below. Keep the numbering monotone (L-2, L-3…) so a
  cross-repo reference like "see upstream ledger L-1" stays stable.
-->

## L-2  Runtime should emit semantic trace signals (loop / redundant / plan-*)

**Symptom.** A researcher watching a session can't see at a glance where
the interesting things happened: the agent got stuck in a tool-call loop,
called the same tool with the same args twice within a few turns,
mid-turn rewrote its plan, or restarted after a tool error. These are the
first four things a debugger wants highlighted, and today the trace tri-view
+ main assistant flow show every step at equal visual weight. The Tree
column has an ✗ glyph for tool errors — that's the only pre-existing signal.

**Root cause.** The runtime wire has no dedicated "signal" event type. All
diagnostic annotations that today's UI could show — loop detection,
redundant-call detection, plan updates, plan restarts, ordinary tool errors
raised to signal status — are inferable from the flat event stream but not
themselves emitted. Concretely:

- `packages/core/agent-loop/src/loop.ts` — the loop sees every tool/call
  and every tool/result but never emits a `trace/signal` derived from them.
- `packages/core/tools/src/index.ts` — tool descriptors don't declare
  loop/retry guardrails that could feed a signal emission.
- `packages/core/planner/` (or the equivalent — grep for `plan` in
  `deepseek-harness-dev/packages/core/`) — plan updates are internal state,
  not observable on the wire.

The desktop renderer therefore has no signal to render.

**Local workaround.** New `src/renderer/trace-signal-detect.js` is a
heuristic detector run over `meta.cachedEvents`. It emits five signal kinds:

- `loop-detected` — ≥ N consecutive same-tool + same-args-prefix calls (N=3)
- `redundant-call` — same (name, args-prefix) reappearing within an 8-seq
  window with at least one different call in between
- `plan-update` — assistant/message text matching "new/revised/updated
  plan", "here's the plan", or a two-line numbered-list intro
- `plan-restart` — same tool re-invoked after a `tool/result` `ok:false`
- `tool-error` — surfaced from the already-visible `ok:false` result, but
  also stamped on the matching call seq so the Graph node (which absorbs
  the result into the call) has a place to hang the badge

Signals are then rendered as:

- Timeline bars: colored dots to the left of each affected row
  (`.trace-timeline-signal-badge` in `style.css`)
- Graph nodes: outer ring around the node
  (`.trace-graph-signal-ring`, highest-priority signal wins the color)
- Assistant turn container: a chip row above the body
  (`.turn-signal-chip-row` / `.turn-signal-chip`), one chip per signal
  kind observed in that turn, clicking a chip auto-opens the trace drawer

The detector already special-cases wire-emitted signals: any event whose
`type === 'trace/signal'` is passed through verbatim (marked `source: 'wire'`)
and the heuristic scan skips seqs already covered by wire signals. This
means the shape is forward-compatible: once upstream lands the fix, the
runtime's signals win and the heuristic scan becomes dead code without
requiring a renderer change.

Spot the workaround in code review by:

- `src/renderer/trace-signal-detect.js` — the entire file
- `src/renderer/trace-timeline.js` — the `options.signals` badge loop
  (around the "Signal badges" comment)
- `src/renderer/trace-graph.js` — the "Signal ring" block inside
  `renderGraph`'s node loop
- `src/renderer/trace-tri-view.js` — the `_computeSignals(records)` call
  passing a `bySeq` map to both Timeline and Graph
- `src/renderer/renderer.js` — `applyTurnSignalChips(sessionId, section)`
  called at the end of `finishTurnContainer`
- `src/renderer/style.css` — the `.trace-timeline-signal-badge` /
  `.trace-graph-signal-ring` / `.turn-signal-chip*` blocks at the tail

**Upstream fix (needed).** Emit `trace/signal` events from the runtime with
this shape:

```
{
  type: 'trace/signal',
  seq: <number>,          // seq the signal decorates (often the tool/call seq)
  time: <number>,
  data: {
    signal: 'loop-detected'|'redundant-call'|'plan-update'|'plan-restart'|'tool-error',
    // signal-specific fields; the renderer uses these for tooltip content:
    name?: string,        // for tool-family signals: which tool
    argsKey?: string,     // 80-char args prefix
    run?: number,         // loop-detected: number of consecutive matches
    priorSeqs?: number[], // loop-detected: earlier calls in the run
    priorSeq?: number,    // redundant-call / plan-restart pointer
    priorErrorSeq?: number,
    snippet?: string,     // plan-update: first 80 chars of the plan text
    error?: string,       // tool-error
  }
}
```

Suggested seams (grep upstream to confirm exact `packages/…` paths — the
comments below cite the same file family as L-1):

1. **Loop/redundant detection** — add a small ring buffer of recent
   `tool/call` (name, argsKey) pairs inside `agent-loop`'s emit path. When
   the buffer trips the threshold, emit `trace/signal` before the offending
   `tool/call` reaches the wire so the signal precedes the call in seq order.
   Threshold defaults (loopN=3, window=8) can be config-flagged.
2. **Plan updates** — plumbed from the planner / plan-summary side. Ideal
   shape: a `plan/updated` event upstream, with `trace-signal` derived from
   it. If the planner state is internal, at minimum emit the "assistant
   drafted a new plan" fact when it happens (the heuristic detector proves
   the text is recoverable, but the wire truth is upstream).
3. **Plan restarts / tool errors** — pair `tool/result` `ok:false` with the
   next same-tool `tool/call` and emit the paired signal at emit time.

The detector-side dedup already covers the "signal already came from the
wire" case, so upstream can ship these one at a time without a big-bang
change: each signal kind lands, its heuristic branch becomes dead code, and
eventually `trace-signal-detect.js` reduces to a pass-through for the wire
signals.

Once all five signal kinds land upstream, the renderer-side detector
becomes pure pass-through (roughly 20 lines) — a small doc-only PR at
that point removes the heuristic scan entirely. Until then, the tri-view
tabs read as "here's what the runtime is showing you" (wire signals) and
"here's what the shell inferred" (heuristic, tooltipped as such).

---

## L-4  Runtime should expose a `models/list` RPC (shell-side static mirror is workaround)

**Symptom.** The shell has no wire-level way to ask the runtime "which
(adapter × model) pairs are actually registered right now?". A researcher
who wires up a new adapter or ships a plugin that calls
`ctx.llm.registerAdapter(...)` at boot has no way to see that model in
the composer dropdown without also editing shell code. Picking a model
the runtime doesn't know about falls through to a `NO_ADAPTER` error,
which the shell recovers from with a "switch profile" affordance — but
the up-front list is a static mirror maintained by hand.

**Root cause.** No `models/list` (or equivalent) RPC on the wire. The
runtime knows its own adapter/model registry — that's what routes each
`llm/call` to the right adapter — but it never exposes that registry to
the shell. The shell therefore has to guess, and today "guess" means
"copy the yml into a JS map".

**Local workaround.**

- `src/main/profiles.js:230` — `PROFILE_MODELS` is a static map,
  `profile name → array of supported model ids`, one entry per row in
  `config/*.yml`.
- `src/main/profiles.js:246` — `modelsFor(name)` is the accessor exported
  to `main.js`.
- `src/main/main.js:280` — the `profiles:models` IPC handler snapshots
  the whole map to the renderer at handshake / profile-switch time.
- `src/renderer/renderer.js:4048` — `renderComposerModel(currentModel)`
  uses the mirror to filter the composer dropdown; if the runtime later
  reports `NO_ADAPTER` we fall back to the "switch profile" affordance.
- `test/model-profile-guard.test.js` — parses every `config/*.yml`
  `models:` field and asserts the yml matches `PROFILE_MODELS` line by
  line, so any yml drift trips the test.

Spot the workaround in code review by the `PROFILE_MODELS` literal at
`src/main/profiles.js:230` and by the guard test — both exist purely
because the runtime never told us.

The workaround is intentionally strict: hand-maintained maps drift, so
the guard test locks yml ↔ map. It does **not** cover runtime-time
`registerAdapter` calls; those still surface only as
`NO_ADAPTER`-then-recover.

**Upstream fix (needed).** Expose a `models/list` RPC on the wire:

```
Method: models/list
Params: none
Result: {
  models: [
    { id: string, adapter: string, capabilities?: { streaming, thinking, ... } }
  ]
}
```

Consumer migration in this shell once the RPC lands:

- Add a `runtime:list-models` IPC and call it once at handshake plus on
  every profile switch.
- Downgrade `PROFILE_MODELS` to a fallback used only when the RPC is
  unavailable (e.g. older runtime).
- Keep `test/model-profile-guard.test.js` — its job becomes narrower
  (yml ↔ fallback consistency), still worth having for older-runtime
  users.

**Precedent in ledger.** Same shape as L-1 (`presentResult` wire),
L-2 (trace semantic signals), L-3 (artifact blob snapshot): the shell
paints over an information gap the runtime should own, and the fix is a
small wire addition that lets the workaround retire.

**Reference.** PR #374 review comment by @ZiyaZhang —
https://github.com/deepseek-harness/deepseek-harness/pull/374#issuecomment-5016306211

---

## L-5  Runtime should expose a mid-turn steer / context-inject RPC on the wire

**Symptom.** The composer cannot send a "steer" while a turn is running. A
researcher watching the agent go down the wrong path mid-turn has no way to
nudge it ("actually, check the other file first") without waiting for the
turn to end. The receiving half of this feature already renders — steering
and context-injection events paint as 📎 cards in the stream and the context
rail — but there is no *send* path: the shell can start a turn
(`session/prompt`) and cancel a turn (`session/cancel`), and nothing in
between.

**Root cause.** The kernel already has the seam; the wire never exposes it.

- `packages/core/agent-loop/src/agent.ts:219` — `Agent.steer(content,
  options)` exists: when a turn is running it accepts the message into the
  inbox as a *steering* message (`steering: true`) rather than starting a new
  turn.
- `packages/core/agent-loop/src/agent.ts:227` — `Agent.inject(content,
  options)` exists: it appends a `context/message` event, turn-enclosed when
  a turn is open (`agent.ts:235`) or wrapped in a one-shot turn when not
  (`agent.ts:247`). This is the model-visible⟺logged injection primitive.
- `packages/ui/jsonrpc/src/protocol.ts:30-43` — the client→server `METHOD`
  map exposes `session/prompt` (`:34`) and `session/cancel` (`:35`) but no
  `session/steer` or `context/inject`. The one mid-turn channel that *does*
  cross the wire goes the other direction: `HOST_METHOD.sessionInterrupt`
  (`protocol.ts:57`) is server→client. There is no client→server verb that
  reaches `agent.steer` / `agent.inject`.

So the runtime can already *do* the thing (the kernel method is shipped and
tested — see `packages/core/agent-loop/tests/agent.spec.ts:196`, a balanced
`turn/start · context/message · turn/end`); the wire just never gave the
shell a way to *ask* for it.

**Local workaround.** Message queue (merged, lane-msg-queue): a mid-turn
Enter doesn't drop the text and doesn't error on the wire's one-in-flight-
prompt rule — it parks the text in a per-session FIFO
(`src/renderer/msg-queue-model.js`) and auto-sends the head as a fresh
`session/prompt` when the current turn ends
(`src/renderer/renderer.js:107` + `drainMsgQueueOnce`). So a steer degrades
to a *queued next-turn message*: the intent survives, but it lands after the
turn instead of redirecting it mid-flight, and it arrives as an ordinary
user prompt rather than a `steering: true` inbox message.

Spot the workaround in code review by `src/renderer/msg-queue-model.js` (the
whole file) and the `drainMsgQueueOnce` / enqueue-on-inflight path in
`renderer.js`. The receiving-side render that's already waiting for the real
feature is `src/renderer/context-rail.js:38` (`context/message`) and
`:46` (`steering/message`) — the 📎 cards light up today for injects the
runtime emits on its own; they'd light up for shell-originated steers the
moment the send path exists.

**Upstream fix (needed).** Add a client→server RPC that rides the existing
kernel seam, e.g.:

```
Method: session/steer            (or context/inject)
Params: {
  sessionId: string,
  content: ContentBlock[],       // the steer/injection payload
  mode?: 'steer' | 'inject',     // steer → agent.steer (running turn only);
                                 // inject → agent.inject (context/message)
  source?: { kind, ... }         // provenance, same shape context/message carries
}
Result: {
  accepted: boolean,             // false if the session id was unknown / disposed
  applied: 'steered' | 'injected' | 'queued'
}
```

The handler in `HarnessSdkServer` routes to `agent.steer(content, options)`
when a turn is running and `agent.inject(content, options)` otherwise — both
already exist (`agent.ts:219,227`). The load-bearing invariant to preserve is
**model-visible ⟺ logged**: whatever the model sees mid-turn must appear on
the session event stream as a `context/message` / `steering/message` (which
`agent.inject` already guarantees via `session.append`), so replay and the
📎 cards stay faithful — no side-channel that reaches the model without a
log record, and no log record the model never saw.

**Precedent in ledger.** Same shape as L-1 / L-2 / L-4: the shell paints
over a gap the runtime should own (here, the receiving half already renders;
only the send verb is missing), and the fix is a small wire addition that
lets the queue workaround retire — once `session/steer` lands, a mid-turn
Enter can route to it instead of the FIFO, and queued-message degradation
becomes the fallback for older runtimes only.

