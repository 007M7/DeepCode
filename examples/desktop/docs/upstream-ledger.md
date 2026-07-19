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
