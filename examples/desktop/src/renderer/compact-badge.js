// Pure classifier for compact-card auto/manual badge.
//
// The intent doc (docs/context-fork-intent.md §2.2) calls out that DSH runs
// compaction on two very different paths:
//
//   - **auto** — the pre-step listener in `dsh-compact-basic` fires mid-turn
//     when the running prompt is close to blowing the context window. It's a
//     safety valve: the runtime shrinks the log to keep the assistant alive.
//     The `compact/summary` event lands inside whatever turn the agent is
//     currently in — most often a `turn/start { trigger.kind: 'user' }`.
//   - **manual** — `compactOnDemand()` is invoked from the shell (the
//     statusbar "Compact now" button on the desktop demo, or the future
//     model-facing `compact` tool). To keep the turn-enclosure invariant
//     intact, it wraps the whole operation in a *self-injected* turn:
//     `turn/start { trigger.kind: 'injection', source.plugin: 'compact' }`.
//
// A reader looking at two identical-looking compact cards can't tell those
// apart. Badging them lets the UI say "the runtime saved you" vs "you asked
// for this" — different confidence, different follow-up. The read comes
// straight off `trigger.source.plugin === 'compact'` (per the intent doc
// red-line: "从 trigger.source.plugin==='compact' 读，不从 UI 状态回推"),
// so the classifier stays a pure function of the last seen `turn/start`
// trigger. The renderer records that trigger per session and hands it in
// here at compact-card render time.
//
// Unknown / missing trigger returns null so the caller can decide whether
// to omit the badge (do that when we honestly can't tell — a persisted-only
// history replay may miss the turn/start).

'use strict'

/**
 * Classify a `turn/start.trigger` value as auto or manual compaction.
 *
 * @param {unknown} trigger - the raw `turn/start.data.trigger` shape from the
 *   session-event stream. Expected discriminated union: `{ kind: 'user' | 'injection' | 'fork' | ..., source?: { kind, plugin? } }`.
 * @returns {{ kind: 'auto' | 'manual', label: string, hint: string } | null}
 *   Returns `null` when the trigger is missing or shaped in a way we can't
 *   safely classify — caller must render without a badge in that case.
 */
function classifyCompactTrigger(trigger) {
  if (!trigger || typeof trigger !== 'object') return null
  // Manual (compactOnDemand): compaction wrapped in a self-injected turn
  // whose source is the compact plugin itself. Any other injection source
  // (steering, subagent-fork, workflow) is not the manual button.
  if (trigger.kind === 'injection') {
    const src = trigger.source
    if (src && typeof src === 'object' && src.kind === 'plugin' && src.plugin === 'compact') {
      return {
        kind: 'manual',
        label: 'manual',
        hint: 'you asked the runtime to compact this session',
      }
    }
    // An injection turn from something other than the compact plugin that
    // *also* contains a compact/summary (e.g. a plugin injects context and
    // compaction runs during its turn) reads as auto: the compact was
    // reactive, not user-requested.
    return {
      kind: 'auto',
      label: 'auto',
      hint: 'the runtime compacted mid-turn to protect the context window',
    }
  }
  // Any other trigger kind (user, fork, tool, …) means compact landed inside
  // a turn the runtime was already in — that's the pre-step safety valve.
  return {
    kind: 'auto',
    label: 'auto',
    hint: 'the runtime compacted mid-turn to protect the context window',
  }
}

// Dual export shape mirrors context-meter.js: CommonJS for node --test,
// `window.__dshCompactBadge` for the renderer. The renderer's script tag
// runs before renderer.js so the handle is ready at the dispatch site.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { classifyCompactTrigger }
}
if (typeof window !== 'undefined') {
  window.__dshCompactBadge = { classifyCompactTrigger }
}
