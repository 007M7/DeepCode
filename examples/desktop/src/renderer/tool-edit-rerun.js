// Tool row "Edit & re-run".
//
// Positioning
// -----------
// Sits on every tool-block card as a small "edit & re-run" action next to
// the `{ }` JSON badge and duration pill on the summary row (§7 grammar:
// full-width row + right-aligned metrics). Clicking it toggles an inline
// panel BELOW the tool card's `args` row: a `<textarea>` seeded with the
// call's pretty-printed arguments, a JSON.parse validator status line, a
// "Re-run with edited args" submit button, and a gray downgrade note. The
// panel lives inside the same tool-block so the researcher sees the edit
// in context with the original args + result — no popups, no side rail.
//
// Honest downgrade
// ----------------
// The runtime does not currently support rewriting historical tool call
// arguments in place. "Re-run with edited args" therefore:
//   1. session/fork the current session at the *tool/call* event's seq
//      (deriveToolBoundary = the tool/call's seq).
//   2. On the child, sendPrompt an `[edit & re-run:tool]` intent message
//      carrying the tool name + old args + new args + downgrade note. The
//      next assistant turn on the fork picks it up in prompt-space and
//      re-drives the tool call itself.
// Gray note under the submit button spells this out ("Backend does not
// rewrite historical tool arguments; edits are delivered as a context
// message on the fork").
//
// Fork-vs-persist gotcha (ticket brief, #112):
//   Live sessions must be persisted before a fork inherits the tail, and
//   the paginated fetch is empty-then-backfill on first visit. We assume
//   the underlying `sessions:fork` IPC already handles the persist-first
//   flow (matches how session-tree-page.js and the "fork here" button on
//   assistant bubbles do it — they don't run their own persist call).
//   The loading-skeleton concern is the child session's history render,
//   handled downstream by selectSession's replay loop, not by this module.
//
// Contract
// --------
// attachToolEditRerun(toolBlockEl, {callId, name, args, seq, sessionId,
//                                   api?, doc?})
//   -> HTMLElement | null
//     toolBlockEl: the <details.tool-block>. We insert the trigger button
//       into the summary and the edit panel after the .args box.
//     seq: the wire seq of the tool/call event (used as the fork boundary).
//     args: the call.arguments string OR object; will be pretty-printed on
//       seed and passed through JSON.parse-validation on submit.
//
// Pure model
// ----------
// parseArgsForEdit(args) -> {parsed:string, error?:string}  — pretty text
//                                                            to seed the
//                                                            textarea.
// coerceEditedArgs(text)   -> {value?:any, error?:string}   — JSON.parse.
// computeToolEdit(oldArgs, newText) -> {hasEdits, newArgs, oldArgs, error}
// buildToolRerunIntentText({callId, name, oldArgs, newArgs, seq}) -> string
// deriveToolBoundary({seq}) -> number|undefined
//
// Exported CommonJS + window.__dshToolEditRerun.

'use strict'

;(function () {

const DOWNGRADE_NOTE =
  'Backend does not rewrite historical tool arguments; edits are delivered ' +
  'as a context message on the fork so the next turn honors them.'

function parseArgsForEdit(args) {
  // Accept both call.arguments-as-string and object shapes so the caller
  // can pass whatever it happens to have. Pretty-print with 2-indent to
  // match the L2 rendering everywhere else. Non-JSON strings survive
  // verbatim so `bash` and friends whose args are already text stay
  // legible; the JSON parse round-trips them back on submit.
  if (args == null) return { parsed: '' }
  if (typeof args === 'string') {
    try {
      const obj = JSON.parse(args)
      return { parsed: JSON.stringify(obj, null, 2) }
    } catch (_) {
      return { parsed: args }
    }
  }
  try {
    return { parsed: JSON.stringify(args, null, 2) }
  } catch (err) {
    return { parsed: '', error: 'Could not pretty-print args: ' + err.message }
  }
}

function coerceEditedArgs(text) {
  const s = text == null ? '' : String(text).trim()
  if (!s) return { error: 'Args cannot be empty.' }
  try {
    const value = JSON.parse(s)
    return { value }
  } catch (err) {
    return { error: 'Invalid JSON: ' + err.message }
  }
}

function computeToolEdit(oldArgs, newText) {
  const parsed = coerceEditedArgs(newText)
  if (parsed.error) return { hasEdits: false, error: parsed.error }
  // Normalize old args to a comparable form. Non-JSON string args (bash)
  // compare as strings; JSON args compare on their canonical stringification
  // so key-order doesn't create a spurious diff.
  const oldNorm = canonicalise(oldArgs)
  const newNorm = canonicalise(parsed.value)
  const hasEdits = oldNorm !== newNorm
  return {
    hasEdits,
    oldArgs: oldArgs == null ? null : oldArgs,
    newArgs: parsed.value,
  }
}

function canonicalise(v) {
  if (v == null) return ''
  if (typeof v === 'string') {
    // Try JSON.parse to promote to a canonical shape; else keep as text.
    try { return JSON.stringify(sortKeys(JSON.parse(v))) } catch (_) { return v }
  }
  try { return JSON.stringify(sortKeys(v)) } catch (_) { return String(v) }
}
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object') {
    const out = {}
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k])
    return out
  }
  return v
}

function buildToolRerunIntentText(opts) {
  const parts = []
  const name = opts && opts.name ? String(opts.name) : 'unknown'
  const callId = opts && opts.callId ? String(opts.callId) : null
  const seq = opts && typeof opts.seq === 'number' ? opts.seq : null
  const oldArgs = opts && opts.oldArgs
  const newArgs = opts && opts.newArgs
  parts.push(`[edit & re-run:tool] Tool "${name}" re-run requested via the demo UI.`)
  if (callId || seq !== null) {
    const bits = []
    if (callId) bits.push(`callId ${callId}`)
    if (seq !== null) bits.push(`seq ${seq}`)
    parts.push(`Forked from tool/call ${bits.join(', ')}.`)
  }
  parts.push('Previous arguments (on the wire):')
  parts.push('```json')
  parts.push(safeStringify(oldArgs))
  parts.push('```')
  parts.push('Requested arguments (from the researcher):')
  parts.push('```json')
  parts.push(safeStringify(newArgs))
  parts.push('```')
  parts.push('(' + DOWNGRADE_NOTE + ')')
  return parts.join('\n')
}

function safeStringify(v) {
  if (v == null) return 'null'
  if (typeof v === 'string') {
    try { return JSON.stringify(JSON.parse(v), null, 2) } catch (_) { return JSON.stringify(v) }
  }
  try { return JSON.stringify(v, null, 2) } catch (_) { return String(v) }
}

function deriveToolBoundary(opts) {
  if (!opts) return undefined
  return typeof opts.seq === 'number' ? opts.seq : undefined
}

// ----------------------------------------------------------------------
// DOM builder
// ----------------------------------------------------------------------

function attachToolEditRerun(toolBlockEl, opts) {
  opts = opts || {}
  const doc = opts.doc || (toolBlockEl && toolBlockEl.ownerDocument) || (typeof document !== 'undefined' ? document : null)
  if (!doc || !toolBlockEl) return null
  const summary = firstChildByTag(toolBlockEl, 'summary') || toolBlockEl
  const api = opts.api || defaultApi()

  // Trigger button on the summary row. Class `.tool-edit-rerun-trigger`
  // rides the same right-cluster grammar as `.tool-json-badge` and
  // `.tool-duration` — CSS parks it between the two (badge, trigger,
  // duration) so the row stays a single flex line.
  const trigger = doc.createElement('button')
  trigger.type = 'button'
  trigger.className = 'ghost small tool-edit-rerun-trigger'
  trigger.textContent = 'edit & re-run'
  trigger.title = 'Fork this session at the tool/call seq and re-run with edited arguments'
  trigger.addEventListener('click', function (ev) {
    // preventDefault cancels the <summary> default action (native toggle
    // of the parent <details>); stopPropagation prevents parent listeners.
    // Both are required — without preventDefault, clicking the trigger
    // while the tool-block is open would collapse the block as a side
    // effect of the native summary click behaviour.
    if (ev && ev.preventDefault) ev.preventDefault()
    if (ev && ev.stopPropagation) ev.stopPropagation()
    // Toggle the edit panel. If the block is closed, force-open it so the
    // panel is reachable (users would otherwise think the button did
    // nothing because the panel lives inside the collapsed <details>).
    if (toolBlockEl.tagName === 'DETAILS' && !toolBlockEl.open) toolBlockEl.open = true
    panel.hidden = !panel.hidden
    if (!panel.hidden) textarea.focus && textarea.focus()
  })
  // Insert BEFORE any existing `.tool-duration` so the pill stays on the
  // far right. When no duration pill exists yet, appendChild keeps the
  // trigger at the tail of the summary — CSS's margin-left auto on the
  // pill handles the reflow on tool/result.
  const durationEl = summary.querySelector ? summary.querySelector('.tool-duration') : null
  if (durationEl && durationEl.parentNode === summary) {
    summary.insertBefore(trigger, durationEl)
  } else {
    summary.appendChild(trigger)
  }

  // Edit panel — inline <div>, seeded hidden. Not <details> nested inside
  // the tool-block's <details> (spec §L1 forbids L1-inside-L1; the tool
  // block IS the L1 for this act, this panel is the fork-intent editor).
  const panel = doc.createElement('div')
  panel.className = 'tool-edit-rerun-panel'
  panel.hidden = true

  const label = doc.createElement('div')
  label.className = 'label tool-edit-rerun-label'
  label.textContent = 'edited args'
  panel.appendChild(label)

  const textarea = doc.createElement('textarea')
  textarea.className = 'tool-edit-rerun-textarea mono'
  textarea.rows = 8
  textarea.spellcheck = false
  const seed = parseArgsForEdit(opts.args)
  textarea.value = seed.parsed || ''
  panel.appendChild(textarea)

  const controls = doc.createElement('div')
  controls.className = 'tool-edit-rerun-controls'
  const status = doc.createElement('span')
  status.className = 'tool-edit-rerun-status muted'
  if (seed.error) status.textContent = seed.error
  controls.appendChild(status)
  const submit = doc.createElement('button')
  submit.type = 'button'
  submit.className = 'primary small tool-edit-rerun-submit'
  submit.textContent = 'Re-run with edited args'
  submit.title = 'Fork at this tool/call and inject an edit intent on the child'
  controls.appendChild(submit)
  panel.appendChild(controls)

  const note = doc.createElement('div')
  note.className = 'tool-edit-rerun-note muted mono'
  note.textContent = DOWNGRADE_NOTE
  panel.appendChild(note)

  // Insert the panel right after the `.args` box (before the `result`
  // label if present). Fallback: appendChild if we can't find `.args`.
  const argsBox = toolBlockEl.querySelector ? toolBlockEl.querySelector('.args') : null
  if (argsBox && argsBox.parentNode === toolBlockEl) {
    if (argsBox.nextSibling) toolBlockEl.insertBefore(panel, argsBox.nextSibling)
    else toolBlockEl.appendChild(panel)
  } else {
    toolBlockEl.appendChild(panel)
  }

  submit.addEventListener('click', function (ev) {
    if (ev && ev.stopPropagation) ev.stopPropagation()
    if (!opts.sessionId) { status.textContent = 'No active session — cannot fork.'; return }
    const edit = computeToolEdit(opts.args, textarea.value)
    if (edit.error) { status.textContent = edit.error; return }
    if (!edit.hasEdits) { status.textContent = 'No changes to re-run.'; return }
    submit.disabled = true
    status.textContent = 'Forking + injecting edit intent…'
    runToolRerun({
      api, sessionId: opts.sessionId, callId: opts.callId, name: opts.name,
      seq: opts.seq, oldArgs: edit.oldArgs, newArgs: edit.newArgs,
    })
      .then(function (res) {
        if (res && res.rejected) {
          status.textContent = 'Fork rejected: ' + (res.message || res.code || 'unknown reason')
        } else if (res && res.childSessionId) {
          const tag = res.mocked ? ' (mocked)' : ''
          status.textContent = `Forked → ${res.childSessionId.slice(0, 8)}…${tag}`
        } else {
          status.textContent = 'Re-run request sent.'
        }
      })
      .catch(function (err) {
        status.textContent = 'Re-run failed: ' + (err && err.message ? err.message : String(err))
      })
      .then(function () { submit.disabled = false })
  })

  return { trigger, panel, textarea, submit, status }
}

async function runToolRerun({ api, sessionId, callId, name, seq, oldArgs, newArgs }) {
  const boundary = deriveToolBoundary({ seq })
  const forkArgs = { sessionId }
  if (typeof boundary === 'number') forkArgs.boundary = boundary
  const forkRet = await api.forkSession(forkArgs)
  if (!forkRet) throw new Error('forkSession returned nothing')
  if (forkRet.rejected) return forkRet
  const childId = forkRet.childSessionId
  if (!childId) throw new Error('forkSession returned no childSessionId')
  const intent = buildToolRerunIntentText({ callId, name, seq, oldArgs, newArgs })
  if (typeof api.selectSession === 'function') {
    try { await api.selectSession(childId) } catch (_) { /* not fatal */ }
  }
  await api.sendPrompt(childId, intent)
  if (typeof api.notify === 'function') {
    api.notify(`Tool-args re-run intent delivered to fork ${childId.slice(0, 8)}…`)
  }
  // pop the fork-compare drawer alongside so the
  // researcher sees the parent's tool call vs the fork's re-run side by
  // side. Same best-effort branch as edit-rerun-header uses.
  const fc = typeof window !== 'undefined' ? window.__dshForkCompare : null
  if (fc && typeof fc.openForkCompare === 'function') {
    try {
      fc.openForkCompare({
        parentId: sessionId,
        childId,
        seq: typeof seq === 'number' ? seq : undefined,
        source: 'tool',
      })
    } catch (_) { /* not fatal */ }
  }
  return forkRet
}

function firstChildByTag(parent, tag) {
  if (!parent || !parent.children) return null
  const T = String(tag || '').toUpperCase()
  for (const c of parent.children) {
    if (c && c.tagName === T) return c
  }
  return null
}

function defaultApi() {
  const w = typeof window !== 'undefined' ? window : null
  const dsh = w && w.dsh ? w.dsh : null
  return {
    forkSession: dsh && dsh.forkSession ? dsh.forkSession.bind(dsh) : (async () => { throw new Error('forkSession bridge missing') }),
    sendPrompt: dsh && dsh.sendPrompt ? dsh.sendPrompt.bind(dsh) : (async () => { throw new Error('sendPrompt bridge missing') }),
    selectSession: w && typeof w.__dshSelectSession === 'function' ? w.__dshSelectSession : null,
    notify: w && typeof w.__dshAppendSystem === 'function' ? w.__dshAppendSystem : null,
  }
}

// -- exports -----------------------------------------------------------

const api = {
  attachToolEditRerun,
  parseArgsForEdit,
  coerceEditedArgs,
  computeToolEdit,
  buildToolRerunIntentText,
  deriveToolBoundary,
  DOWNGRADE_NOTE,
}
if (typeof module !== 'undefined' && module.exports) module.exports = api
if (typeof window !== 'undefined') window.__dshToolEditRerun = api

})();
