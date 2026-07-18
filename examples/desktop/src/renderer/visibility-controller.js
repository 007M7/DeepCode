// Renderer-side visibility controller (batch B of the P0 renderer audit).
//
// Self-contained IIFE that installs its own `window.dsh.onNotify` listener and
// injects visibility surface — nothing in renderer.js is modified. Six event
// families that today fall to a muted `event: <type>` line or drop details get
// dedicated rendering here:
//
//   - todo/write         → sticky "Todo list" card at top of the active stream,
//                          updated in place on each write (last-write-wins)
//   - prompt/blocked     → red-tinged card with reason + foldable blocked text
//   - turn/end           → an extra system line (error/max-tokens/rejected/aborted)
//                          appended *after* renderer.js's own bland line
//   - subagent.finished  → folded lastAssistantMessage summary line
//   - bash/sandbox-mode  → header badge (sandbox mode chip)
//   - permission/preset  → header badge (permission preset chip)
//   - approval/asked+decided → muted audit row anchored to the tool block
//                              when we can find its callId, otherwise inline
//
// Correctness contracts kept in step with the pure module (visibility.js):
//   • payload shapes match packages/core/session/src/types.ts + neighbours
//     (see visibility.js header for the source-of-truth files)
//   • no state escapes per-session; a session switch replays fresh via
//     renderer.js's history replay, and each render is idempotent by DOM ref
//   • badges live in a shell-owned container appended to `.debug` — the
//     existing header structure is untouched
//
// Parallel-agent boundary: this file only appends new DOM. It does not
// modify existing renderer.js rendering, nor share state with other agents'
// modules. See docs/capability-ui-coverage.md gap rows P0-3/4/7/8/11/12/13.

'use strict'

;(function () {
  // Guard on the pure module — if visibility.js failed to load the controller
  // stays dormant instead of throwing during boot.
  if (typeof globalThis === 'undefined' || !globalThis.Visibility) {
    console.warn('[visibility] Visibility helper missing; controller inert')
    return
  }
  const V = globalThis.Visibility

  // Per-session tracker: the todo card DOM ref (one per session, updated in
  // place) and a map of approval-asked payloads by request id (used to enrich
  // the paired approval-decided audit row).
  /** @type {Map<string, {todoCard: HTMLElement | null, approvals: Map<string, any>}>} */
  const perSession = new Map()

  function trackerFor(sessionId) {
    let t = perSession.get(sessionId)
    if (!t) {
      t = { todoCard: null, approvals: new Map() }
      perSession.set(sessionId, t)
    }
    return t
  }

  // -- DOM refs (resolved lazily so the IIFE can run before DOMContentLoaded) -

  function streamEl() { return document.getElementById('stream') }
  function debugEl() {
    // Live in the chat pane header so mode chips sit next to the mock buttons.
    // Fallback to null (we simply don't render badges) if the shell layout
    // is missing the pane.
    const chatPane = document.querySelector('.pane[data-pane="chat"]')
    if (!chatPane) return null
    return chatPane.querySelector('.header .debug')
  }

  function scrollToBottom() {
    const s = streamEl(); if (s) s.scrollTop = s.scrollHeight
  }

  // -- todo card (P0-3) ------------------------------------------------------

  function renderTodoCard(sessionId, todosPayload) {
    const s = streamEl(); if (!s) return
    const model = V.foldTodoList(todosPayload && todosPayload.todos)
    const t = trackerFor(sessionId)
    let card = t.todoCard && s.contains(t.todoCard) ? t.todoCard : null
    if (!card) {
      card = document.createElement('div')
      card.className = 'visibility-card todo-card'
      card.dataset.sessionId = sessionId
      s.appendChild(card)
      t.todoCard = card
    }
    card.innerHTML = ''

    const head = document.createElement('div')
    head.className = 'todo-head'
    const title = document.createElement('span')
    title.className = 'todo-title'
    title.textContent = 'Todo list'
    const summary = document.createElement('span')
    summary.className = 'todo-summary'
    summary.textContent = `${model.counts.in_progress} in progress · ${model.counts.pending} pending · ${model.counts.completed} done`
    head.appendChild(title)
    head.appendChild(summary)
    card.appendChild(head)

    if (model.items.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'todo-empty muted'
      empty.textContent = model.warnings.length > 0
        ? `Empty list — ${model.warnings[0]}`
        : 'Empty list.'
      card.appendChild(empty)
    } else {
      const ul = document.createElement('ul')
      ul.className = 'todo-items'
      for (const it of model.items) {
        const li = document.createElement('li')
        li.className = `todo-item status-${it.status}`
        const icon = document.createElement('span')
        icon.className = 'todo-icon'
        icon.textContent = it.icon
        const text = document.createElement('span')
        text.className = 'todo-text'
        text.textContent = it.content
        li.appendChild(icon)
        li.appendChild(text)
        ul.appendChild(li)
      }
      card.appendChild(ul)
    }

    if (model.warnings.length > 0 && model.items.length > 0) {
      const warn = document.createElement('div')
      warn.className = 'todo-warn'
      warn.textContent = `! ${model.warnings.join('; ')}`
      card.appendChild(warn)
    }
    scrollToBottom()
  }

  // -- prompt/blocked row (viz-coverage-matrix §5 P0-1) ---------------------
  //
  // Spec (matrix §5 row 1 + task brief): "红边行式卡（全宽左对齐，非居中），
  // L1 展开 raw reason；L2 照旧；复用现有 error 行 style token". So the
  // surface is a compact single row `✗ prompt blocked · <reason>` rather
  // than the multi-part card the first cut used — matches the density
  // spec's "one line per event, expand into detail on click" rule and the
  // centered-card ban (§7). The details toggle carries raw reason + raw
  // blocked content so nothing is lost.
  //
  // DOM shape:
  //   <details class="visibility-card prompt-blocked-row">
  //     <summary class="pb-row-head">
  //       <span class="pb-row-icon">✗</span>
  //       <span class="pb-row-label">prompt blocked</span>
  //       <span class="pb-row-sep">·</span>
  //       <span class="pb-row-reason"><reason></span>
  //     </summary>
  //     <div class="pb-row-body">
  //       (reason full text if truncated)
  //       (blocked prompt <pre>)
  //     </div>
  //   </details>
  function renderPromptBlocked(_sessionId, data) {
    const s = streamEl(); if (!s) return
    const model = V.foldPromptBlocked(data)
    if (!model) return
    const row = document.createElement('details')
    row.className = 'visibility-card prompt-blocked-row'
    // NOTE deliberately not opening by default — a blocked prompt is a
    // recoverable state (the user just needs to try again), not a modal
    // failure. Icon + reason are the always-visible summary.
    const head = document.createElement('summary')
    head.className = 'pb-row-head'
    const icon = document.createElement('span')
    icon.className = 'pb-row-icon'
    icon.textContent = '✗'
    const label = document.createElement('span')
    label.className = 'pb-row-label'
    label.textContent = 'prompt blocked'
    const sep = document.createElement('span')
    sep.className = 'pb-row-sep'
    sep.textContent = '·'
    const reason = document.createElement('span')
    reason.className = 'pb-row-reason'
    // Truncate long reasons in the summary line; full copy lives in the
    // <details> body below (opened by clicking the row).
    reason.textContent = model.reason.length > 120
      ? `${model.reason.slice(0, 117)}…`
      : model.reason
    head.append(icon, label, sep, reason)
    row.appendChild(head)

    const body = document.createElement('div')
    body.className = 'pb-row-body'
    if (model.reason.length > 120) {
      const full = document.createElement('div')
      full.className = 'pb-row-reason-full'
      full.textContent = `reason: ${model.reason}`
      body.appendChild(full)
    }
    if (model.text) {
      const bodyLabel = document.createElement('div')
      bodyLabel.className = 'pb-row-body-label'
      bodyLabel.textContent = `blocked ${model.source} prompt:`
      body.appendChild(bodyLabel)
      const pre = document.createElement('pre')
      pre.className = 'pb-pre'
      pre.textContent = model.text
      body.appendChild(pre)
    }
    row.appendChild(body)
    s.appendChild(row)
    scrollToBottom()
  }

  // -- turn/end detail (P0-7 legacy shim) -----------------------------------
  //
  // Field §3 P0 #4 (2026-07-17): renderer.js's turn/end handler now emits
  // the FULL detail (kind + step + message + code, truncated with a title
  // attribute) via visibility.js:formatTurnEndLine — see renderer.js's
  // `turn/end` case. This function stays as a no-op shim so callers that
  // depended on the old two-line shape (tests referencing
  // `V.renderTurnEndDetail`, viz-p0-gaps mock buttons) don't error out. It
  // no longer appends anything: the second line would duplicate detail that
  // is already on the primary system line.

  function renderTurnEndDetail(_sessionId, _data) {
    // Intentionally no-op — retained for API stability. See the block
    // comment above for the migration path.
  }

  // -- subagent finished summary (P0-8) -------------------------------------

  function renderSubagentFinishedSummary(params) {
    const s = streamEl(); if (!s) return
    const sum = V.summarizeSubagentFinished(params)
    if (!sum) return
    const line = document.createElement('div')
    line.className = 'visibility-subagent-summary'
    const label = document.createElement('span')
    label.className = 'sas-label'
    const shortAgent = typeof params.agentId === 'string'
      ? params.agentId.slice(0, 12)
      : '?'
    label.textContent = `↳ ${shortAgent} said: `
    const brief = document.createElement('span')
    brief.className = 'sas-brief'
    brief.textContent = sum.oneLine
    line.appendChild(label)
    line.appendChild(brief)
    if (sum.full !== sum.oneLine) {
      const details = document.createElement('details')
      details.className = 'sas-full'
      const summary = document.createElement('summary')
      summary.textContent = 'full'
      details.appendChild(summary)
      const pre = document.createElement('pre')
      pre.className = 'sas-pre'
      pre.textContent = sum.full
      details.appendChild(pre)
      line.appendChild(details)
    }
    s.appendChild(line)
    scrollToBottom()
  }

  // -- header badges (P0-11 sandbox, P0-12 preset) --------------------------

  function ensureBadge(id, label) {
    const host = debugEl()
    if (!host) return null
    let el = document.getElementById(id)
    if (!el) {
      el = document.createElement('span')
      el.id = id
      el.className = 'visibility-badge'
      el.dataset.label = label
      // Place badges BEFORE the mock buttons so they read as the leading status
      // chips, not tail actions. `.debug` is the last child in the header row;
      // prepending here keeps them in the same visual block.
      host.insertBefore(el, host.firstChild)
    }
    return el
  }

  function updateSandboxBadge(mode) {
    const el = ensureBadge('vb-sandbox', 'sandbox')
    if (el) {
      el.textContent = `sandbox: ${mode}`
      el.className = `visibility-badge sandbox-badge sandbox-${mode}`
      el.title = 'bash/sandbox-mode (last write on this session)'
      flashBadge(el)
    }
    // Also drop a compact divider in the main stream at the moment of
    // change (viz-coverage-matrix §5 P0-3/4 + task brief: divider
    // semantics match compact-divider). The header badge shows the
    // *current* state; the divider anchors *when* the switch happened.
    appendModeDivider('sandbox', mode)
  }

  function updatePresetBadge(preset) {
    const el = ensureBadge('vb-preset', 'preset')
    if (el) {
      el.textContent = `preset: ${preset}`
      el.className = 'visibility-badge preset-badge'
      el.title = 'permission/preset (last write on this session)'
      flashBadge(el)
    }
    appendModeDivider('preset', preset)
  }

  // Compact divider row for mode/preset switches — same visual grammar as
  // `.compact-divider` (centre-aligned dashed rule with a labeled centre)
  // but scoped to permission/sandbox events so a reader in the middle of a
  // session sees exactly when the security context changed. Deduped
  // against the immediately-preceding divider of the same kind+value so a
  // replay that re-emits the same event doesn't stack N duplicate lines.
  function appendModeDivider(kind, value) {
    const s = streamEl(); if (!s) return
    const last = s.lastElementChild
    if (last && last.classList && last.classList.contains('mode-divider')
        && last.dataset.kind === kind && last.dataset.value === value) {
      return
    }
    const line = document.createElement('div')
    line.className = `mode-divider mode-divider-${kind}`
    line.dataset.kind = kind
    line.dataset.value = value
    const label = document.createElement('span')
    label.className = 'mode-divider-label'
    label.textContent = kind === 'sandbox'
      ? `── sandbox → ${value} ──`
      : `── permission preset → ${value} ──`
    line.appendChild(label)
    s.appendChild(line)
    scrollToBottom()
  }

  function flashBadge(el) {
    el.classList.remove('flash')
    // Force a reflow so re-adding the class replays the animation.
    void el.offsetWidth
    el.classList.add('flash')
  }

  // -- approval audit row (viz-coverage-matrix §5 P0-2) ---------------------
  //
  // Spec (matrix §5 row 2 + task brief): "自动决策的审批在对应 tool 行内加
  // inline note（auto-approved · <preset> 灰字小行）". Two placements:
  //
  //   (a) TOOL-ANCHORED — asked.callId matches a live .tool-block: mount
  //       the note INSIDE that block (as a small footer row) so a reader
  //       reading the tool call also sees "auto-allowed by ask-once/…"
  //       right there instead of a floating audit line above/below.
  //
  //   (b) FALLBACK — no callId or no matching block: emit as a standalone
  //       audit line at the tail. Same visual grammar as the visibility-
  //       audit lines used by hook/* audit surfaces.
  //
  // Both paths reach `V.auditRowForApproval` which normalises the outcome
  // vocabulary (allowed / rejected / cancelled / unavailable) and picks a
  // tone (ok / warn / error). The reason (optional) is the asker's human-
  // readable explanation — e.g. "preset: ask-once → allow".
  function renderApprovalAudit(sessionId, decidedData) {
    const t = trackerFor(sessionId)
    const asked = decidedData && decidedData.id ? t.approvals.get(decidedData.id) : null
    if (decidedData && decidedData.id) t.approvals.delete(decidedData.id)
    const row = V.auditRowForApproval(asked, decidedData)
    if (!row) return

    // Try tool-anchored placement first. `.tool-block` is renderer.js's
    // appendToolCall root; the inline note sits after the block's <summary>
    // (so it reads as part of the tool row even when the block is folded).
    let anchor = null
    if (asked && asked.callId) {
      anchor = document.querySelector(`.tool-block[data-call-id="${cssEscape(asked.callId)}"]`)
    }
    if (anchor) {
      const note = document.createElement('div')
      note.className = `tool-approval-note tone-${row.tone}`
      const glyph = row.tone === 'ok' ? '✓' : row.tone === 'error' ? '✗' : '·'
      const parts = [`${glyph} auto-${row.verb}`]
      if (row.reason) parts.push(`· ${row.reason}`)
      note.textContent = parts.join(' ')
      note.title = `approval/decided: ${row.outcome}${asked && asked.callId ? ` (callId ${asked.callId})` : ''}`
      // Insert after the <summary> so the note is visible even when the
      // <details> body is collapsed. .tool-block is a <details>; its first
      // child is the <summary> element.
      const summary = anchor.querySelector(':scope > summary')
      if (summary) {
        anchor.insertBefore(note, summary.nextSibling)
      } else {
        anchor.appendChild(note)
      }
      return
    }

    // Fallback: standalone audit line at the tail.
    const line = document.createElement('div')
    line.className = `visibility-audit visibility-audit-${row.tone}`
    const glyph = row.tone === 'ok' ? '✓' : row.tone === 'error' ? '✗' : '·'
    const parts = [`${glyph} auto-${row.verb}: ${row.toolName}`]
    if (row.reason) parts.push(`— ${row.reason}`)
    line.textContent = parts.join(' ')
    const s = streamEl(); if (s) s.appendChild(line)
    scrollToBottom()
  }

  function cssEscape(v) {
    // Minimal escape — call ids are opaque strings that in practice are
    // hex/uuid-ish, but be defensive against any character that would break
    // a CSS attribute selector.
    return String(v).replace(/(["\\])/g, '\\$1')
  }

  // -- dispatch --------------------------------------------------------------

  function handleNotify(payload) {
    if (!payload || typeof payload !== 'object') return
    const { method, params } = payload
    if (method === 'subagent.finished') {
      renderSubagentFinishedSummary(params || {})
      return
    }
    if (method !== 'session.event') return
    const sessionId = params && params.sessionId
    const event = params && params.event
    if (!sessionId || !event) return
    const bucket = V.classifyEvent(event)
    switch (bucket.kind) {
      case 'todo':
        renderTodoCard(sessionId, bucket.data); return
      case 'prompt-blocked':
        renderPromptBlocked(sessionId, bucket.data); return
      case 'turn-end':
        // Field §3 P0 #4 (2026-07-17): renderer.js's primary turn/end system
        // line now carries the full detail (step + message + code) via
        // visibility.js:formatTurnEndLine. Keeping the dispatch as a no-op
        // so `V.classifyEvent` stays stable for other callers/tests.
        renderTurnEndDetail(sessionId, bucket.data); return
      case 'sandbox-mode':
        if (bucket.data && typeof bucket.data.mode === 'string') updateSandboxBadge(bucket.data.mode)
        return
      case 'permission-preset':
        if (bucket.data && typeof bucket.data.preset === 'string') updatePresetBadge(bucket.data.preset)
        return
      case 'approval-asked': {
        // Stash the ask; the audit row is emitted on the paired decided event.
        if (bucket.data && bucket.data.id) trackerFor(sessionId).approvals.set(bucket.data.id, bucket.data)
        return
      }
      case 'approval-decided':
        renderApprovalAudit(sessionId, bucket.data); return
      default: return
    }
  }

  function wire() {
    if (!window.dsh || typeof window.dsh.onNotify !== 'function') {
      console.warn('[visibility] window.dsh.onNotify unavailable; controller inert')
      return
    }
    window.dsh.onNotify(handleNotify)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire)
  } else {
    wire()
  }

  // Expose the internal renderers so mock buttons or future integration tests
  // can drive the visibility surface without a running runtime.
  globalThis.VisibilityController = Object.freeze({
    _handleNotify: handleNotify,
    renderTodoCard,
    renderPromptBlocked,
    renderTurnEndDetail,
    renderSubagentFinishedSummary,
    updateSandboxBadge,
    updatePresetBadge,
    renderApprovalAudit,
  })
})()
