// Session Tree page controller. Renders the "every session as a branchable
// timeline" view described in docs/product-ia-design.md §2.
//
// Data source: server-authoritative session/list snapshot via
// `window.__dshChat.getEntries()`, refreshed on tab switch by
// renderer.js's switchTo('tree') hook. Timeline data comes from
// window.dsh.sessionEvents(id) — same wire the chat pane uses for replay, so
// no new protocol surface.
//
// Rendering model:
//   - Left column: <ul.tree-list> nested <li.tree-row>. Depth encoded by
//     inline padding + a 1px connector column drawn with CSS box-shadow.
//     Edge kind (fork vs subagent) is data-edge on the row so CSS picks the
//     right connector style (solid + fork glyph / dashed + robot glyph).
//   - Right column: preview card for the selected node. Metadata pulled
//     straight from the entry; timeline dots computed by classifyEvent from
//     session-tree.js so buckets stay aligned with the pure module's contract.
//   - Compare mode: ⇧-click a second same-parent row to enter it. Two
//     timelines rendered side-by-side with the fork boundary highlighted.
//
// No new IPC — only calls existing renderer.js exports (`__dshChat`,
// `__dshTabs`) and preload's `sessionEvents`/`forkSession` bridges.

'use strict'

;(function () {
  if (typeof window === 'undefined' || !window.dsh) return
  // The pure tree helpers are exported globally by session-tree.js; abort
  // silently if that script somehow failed to load so the page just stays
  // in its empty state rather than crashing.
  if (!globalThis.SessionTree) return

  const state = {
    selectedId: null,
    // Compare mode: second selection lives here. Cleared on any single-click
    // selection change or on Close.
    compareId: null,
    // Cache of last-fetched event listings so re-selecting a node doesn't hit
    // the wire again. Cleared when the entry list changes underneath us.
    eventCache: new Map(), // sessionId -> [{seq,type}]
    // Track which entry ids we've already seen so we know when to bust the
    // event cache (e.g. a new turn landed on a session we already fetched).
    entrySignature: '',
    // "Earlier sessions" (untitled/smoke leaf) group collapsed by default so
    // the first paint stays clean; toggled by the group head.
    earlierExpanded: false,
    // When set, a mock 3-level demo forest is shown instead of the real
    // session list. Cleared by the "Clear demo" button (visible only while
    // a demo is loaded).
    demoEntries: null,
  }

  // ---- helpers -------------------------------------------------------------

  function $ (id) { return document.getElementById(id) }

  function entries() {
    if (state.demoEntries) return state.demoEntries
    const chat = window.__dshChat
    if (!chat || typeof chat.getEntries !== 'function') return []
    return chat.getEntries() || []
  }

  function findEntry(id) {
    for (const e of entries()) if (e && e.sessionId === id) return e
    return null
  }

  // Prefer the CN-locale rel-time helper the sidebar HISTORY already uses so
  // the tree page and the sidebar don't render two conflicting time formats
  // for the same session. Fall back to an in-module EN table only if the
  // pure helpers module never loaded (defensive; keeps the page usable).
  function relTime(ts) {
    if (!ts) return ''
    const panels = window.__dshPanelsC
    if (panels && typeof panels.relativeTime === 'function') {
      return panels.relativeTime(ts, Date.now())
    }
    const delta = Date.now() - ts
    if (delta < 60_000) return 'just now'
    if (delta < 3600_000) return `${Math.floor(delta / 60_000)}m ago`
    if (delta < 86400_000) return `${Math.floor(delta / 3600_000)}h ago`
    return `${Math.floor(delta / 86400_000)}d ago`
  }

  function shortId(id) {
    if (!id) return ''
    return id.length > 12 ? id.slice(0, 8) + '…' : id
  }

  // fix: real user prompts pass through unchanged; smoke fixtures and
  // the old `(shortId)` fallback collapse to "Untitled · <rel>" via the shared
  // smartSessionTitle helper. Result carries an `isUntitled` flag so the row
  // can pick the muted-italic style, and it is also the discriminant that
  // sends a session into the "Earlier sessions" collapsed group.
  function titleInfo(entry) {
    if (!entry) return { text: 'Untitled', isUntitled: true }
    const panels = window.__dshPanelsC
    if (panels && typeof panels.smartSessionTitle === 'function') {
      return panels.smartSessionTitle(entry, Date.now())
    }
    // Fallback path — pure helpers not loaded. Best-effort match on the two
    // known placeholder shapes so we don't render "(smoke-...)" as a real
    // title even in the degraded case.
    const raw = (entry.header && entry.header.title) || entry.title || ''
    const trimmed = typeof raw === 'string' ? raw.trim() : ''
    const looksPlaceholder = /^\(?smoke-/i.test(trimmed) ||
      (typeof entry.sessionId === 'string' && trimmed === `(${entry.sessionId.slice(0, 8)})`)
    if (trimmed && !looksPlaceholder) return { text: trimmed, isUntitled: false }
    const rel = relTime(entry.lastEventTime)
    return { text: rel ? `Untitled · ${rel}` : 'Untitled', isUntitled: true }
  }

  function displayTitle(entry) {
    return titleInfo(entry).text
  }

  // ---- tree render ---------------------------------------------------------

  function renderTree() {
    const listEl = $('tree-list')
    const emptyEl = $('tree-empty')
    const countEl = $('tree-count')
    if (!listEl) return
    // Demo forest wins over the real list once loaded, so the "Load demo
    // tree" button in the empty state produces a self-contained preview even
    // when the daemon has 50 smoke rows underneath.
    const all = state.demoEntries || entries()
    // C-P1-5: the sidebar Recent list reports total-recent count (e.g. 25);
    // this page renders the currently-visible tree. Two numbers that count
    // different things read as a discrepancy. Match Recent's filter so the
    // tree count corresponds to what's actually drawn (ghost sessions with
    // no user message ever sent are dropped by the same predicate).
    const panels = window.__dshPanelsC
    const visible = panels && typeof panels.filterEmptySessions === 'function'
      ? panels.filterEmptySessions(all)
      : all
    countEl.textContent = String(visible.length)
    // Demo-forest chip in tree-nav-head (fix/demo-labels): once a reader hits
    // "Load demo tree" the entries look real (`demo-*` ids + parent+child
    // relationships + real-looking titles). The "Clear demo" button in the
    // empty-state actions is one hint but disappears once the tree paints,
    // so we hang a persistent chip in the meta strip while demoEntries is
    // set. Same wording as the load button so a reader connects the two.
    const head = document.querySelector('.tree-nav-head')
    if (head) {
      let chip = head.querySelector('.tree-nav-demo-chip')
      if (state.demoEntries) {
        if (!chip) {
          chip = document.createElement('span')
          chip.className = 'demo-tier-chip tree-nav-demo-chip'
          chip.textContent = 'demo forest'
          chip.title = '3-level example forest (mock; not real sessions). Use "Clear demo" from the empty state to drop back to your real tree.'
          head.appendChild(chip)
        }
      } else if (chip) {
        chip.remove()
      }
    }
    listEl.innerHTML = ''
    if (all.length === 0) {
      emptyEl.hidden = false
      renderEmptyState(emptyEl, 'empty')
      return
    }

    // Bust the timeline cache if the entry set changed (new session, new
    // event count on a known session) — cheap signature over the fields the
    // preview reads.
    const sig = all.map((e) => `${e.sessionId}:${e.lastEventTime || 0}:${e.eventCount || 0}`).join('|')
    if (sig !== state.entrySignature) {
      state.eventCache.clear()
      state.entrySignature = sig
    }

    const forest = globalThis.SessionTree.buildSessionTree(all)
    // Roots ordered by recency so the active session floats to the top —
    // matches the sidebar's convention so users don't relearn ordering.
    forest.sort((a, b) => (b.entry.lastEventTime || 0) - (a.entry.lastEventTime || 0))

    // Noise collapse (team-lead's fix): 51 smoke roots with no
    // children and no real title were drowning the tree on first open. Now
    // split roots into "meaningful" (real title OR has any descendants) and
    // "untitled leaves" (flat placeholders). Meaningful ones render inline;
    // leaves fold into an expandable "Earlier sessions (N)" group at the
    // bottom so the useful signal comes first.
    const meaningful = []
    const untitledLeaves = []
    for (const root of forest) {
      const info = titleInfo(root.entry)
      const hasChildren = Array.isArray(root.children) && root.children.length > 0
      if (!info.isUntitled || hasChildren) meaningful.push(root)
      else untitledLeaves.push(root)
    }

    for (const root of meaningful) emitNode(listEl, root, null)

    if (untitledLeaves.length > 0) {
      emitEarlierGroup(listEl, untitledLeaves)
    }

    // If every real entry was untitled + leaf we still want the guided empty
    // state visible — otherwise the tree opens with only a collapsed group
    // and no explanation.
    if (meaningful.length === 0) {
      emptyEl.hidden = false
      renderEmptyState(emptyEl, 'all-noise')
    } else {
      emptyEl.hidden = true
    }
  }

  // "Earlier sessions" — a single dedicated <li> at the bottom of the list
  // holding an expandable summary + a nested <ul> of the untitled leaves.
  // Keeps DOM shape stable (still a flat <ul> of <li>s) so hover/click
  // handlers below don't need to special-case anything.
  function emitEarlierGroup(container, leaves) {
    const li = document.createElement('li')
    li.className = 'tree-row tree-row-earlier'
    li.dataset.earlier = String(state.earlierExpanded ? 'expanded' : 'collapsed')

    const head = document.createElement('button')
    head.type = 'button'
    head.className = 'tree-earlier-head'
    head.setAttribute('aria-expanded', String(!!state.earlierExpanded))
    const caret = document.createElement('span')
    caret.className = 'tree-earlier-caret'
    caret.innerHTML = '<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="M4 3l4 3-4 3"/></svg>'
    const label = document.createElement('span')
    label.className = 'tree-earlier-label'
    label.textContent = `Earlier sessions (${leaves.length})`
    const hint = document.createElement('span')
    hint.className = 'tree-earlier-hint muted'
    hint.textContent = 'untitled or smoke fixtures'
    head.appendChild(caret)
    head.appendChild(label)
    head.appendChild(hint)
    head.addEventListener('click', () => {
      state.earlierExpanded = !state.earlierExpanded
      renderTree()
    })
    li.appendChild(head)

    if (state.earlierExpanded) {
      const inner = document.createElement('ul')
      inner.className = 'tree-list tree-list-earlier'
      // Leaves stay at depth 0 in the buildSessionTree sense; we just render
      // them one indent step in via CSS on `.tree-list-earlier .tree-row` so
      // the fork/subagent connector logic doesn't trip on synthetic depths.
      for (const leaf of leaves) emitNode(inner, leaf, null)
      li.appendChild(inner)
    }

    container.appendChild(li)
  }

  // Guided empty state — different copy for "no sessions at all" vs "every
  // session collapsed to noise" so the user knows why the tree looks bare.
  // Both variants offer the "Load demo tree" button which injects a 3-level
  // canned forest via loadDemoTree(); the button is the safest onboarding
  // affordance (mock is clearly labelled once it's on screen).
  function renderEmptyState(el, variant) {
    if (!el) return
    el.innerHTML = ''
    const title = document.createElement('div')
    title.className = 'tree-empty-title'
    const body = document.createElement('div')
    body.className = 'tree-empty-body muted'
    if (variant === 'all-noise') {
      title.textContent = 'Nothing forked yet.'
      body.textContent = 'The sessions here are all flat placeholders. Start a chat and use "Fork from here" on any turn to grow a branch.'
    } else {
      title.textContent = 'No sessions yet.'
      body.textContent = 'Every session shows up here as a branchable timeline. Start a chat, then fork any turn to see the tree fill in.'
    }
    const actions = document.createElement('div')
    actions.className = 'tree-empty-actions'
    const demoBtn = document.createElement('button')
    demoBtn.type = 'button'
    demoBtn.className = 'ghost small'
    demoBtn.textContent = 'Load demo tree'
    demoBtn.title = 'Preview a 3-level example forest (mock; clearly labelled).'
    demoBtn.addEventListener('click', () => loadDemoTree())
    actions.appendChild(demoBtn)
    if (state.demoEntries) {
      const dropBtn = document.createElement('button')
      dropBtn.type = 'button'
      dropBtn.className = 'ghost small'
      dropBtn.textContent = 'Clear demo'
      dropBtn.addEventListener('click', () => {
        state.demoEntries = null
        state.selectedId = null
        renderTree()
        void renderPreview()
      })
      actions.appendChild(dropBtn)
    }
    el.appendChild(title)
    el.appendChild(body)
    el.appendChild(actions)
  }

  // Demo forest — 3 real roots, 2 with children, one child with a
  // grand-child so users see both fork edges and subagent edges without
  // touching the daemon.
  //
  // child titles now DELIBERATELY copy the parent's title
  // (empty-title children inherit at seed time in real usage — the daemon
  // seeds the fork's title from the parent's mirrored header). The renderer
  // derives the row label via forkChildLabel() instead of trusting the
  // copied title, so the demo forest exercises that path.
  function loadDemoTree() {
    const now = Date.now()
    const min = (n) => now - n * 60_000
    const entries = [
      { sessionId: 'demo-root-1', title: 'Rewrite Session Tree page', lastEventTime: min(2), eventCount: 42, header: { title: 'Rewrite Session Tree page', model: 'claude-fable-5', cwd: '~/harness/dsh-desktop-demo' }, running: true, hasUserMessage: true },
      // Both fork children inherit parent's title (same bug shape as the
      // screenshot). Only 1b has a new user message (title differs → label
      // shows the child's own message); 1a is a fresh fork with no new
      // turn (title still equal → label shows "no new messages yet").
      { sessionId: 'demo-fork-1a', title: 'Rewrite Session Tree page', lastEventTime: min(8), eventCount: 3, header: { title: 'Rewrite Session Tree page', parentSession: 'demo-root-1', seedLength: 22, model: 'claude-fable-5' }, hasUserMessage: false },
      { sessionId: 'demo-fork-1b', title: 'try a different palette', lastEventTime: min(14), eventCount: 12, header: { title: 'try a different palette', parentSession: 'demo-root-1', seedLength: 22, model: 'claude-fable-5' }, hasUserMessage: true },
      { sessionId: 'demo-sub-1a1', title: 'run lint report', lastEventTime: min(6), eventCount: 8, header: { title: 'run lint report', parentSession: 'demo-fork-1a', originKind: 'subagent', seedLength: 4, model: 'claude-haiku-4-5' }, hasUserMessage: true },
      { sessionId: 'demo-root-2', title: 'Research memory-plugin candidates', lastEventTime: min(45), eventCount: 87, header: { title: 'Research memory-plugin candidates', model: 'claude-fable-5', cwd: '~/harness/memory-capability-plan.md', awaitingApproval: true }, hasUserMessage: true },
      { sessionId: 'demo-sub-2a', title: 'scrape mem0 README', lastEventTime: min(50), eventCount: 6, header: { title: 'scrape mem0 README', parentSession: 'demo-root-2', originKind: 'subagent', seedLength: 12, model: 'claude-haiku-4-5' }, hasUserMessage: true },
      { sessionId: 'demo-root-3', title: 'Check PR #372 regression', lastEventTime: min(180), eventCount: 33, header: { title: 'Check PR #372 regression', model: 'claude-fable-5' }, hasUserMessage: true },
    ]
    state.demoEntries = entries
    state.earlierExpanded = false
    // Land the user on the root that's actively running so the preview card
    // has interesting metadata on first paint.
    state.selectedId = 'demo-root-1'
    renderTree()
    void renderPreview()
  }

  function emitNode(container, node, parentEntry) {
    const li = document.createElement('li')
    li.className = 'tree-row'
    li.dataset.sessionId = node.entry.sessionId
    li.dataset.depth = String(node.depth)
    li.style.setProperty('--depth', String(node.depth))
    // Edge kind: header.originKind === 'subagent' → dashed edge with robot
    // glyph; otherwise treat any child as a user-initiated fork. Roots (depth
    // 0) have no incoming edge.
    const originKind = node.entry.header && node.entry.header.originKind
    const edge = node.depth === 0 ? 'root'
      : originKind === 'subagent' ? 'subagent' : 'fork'
    li.dataset.edge = edge

    // Row inner: [status dot] [body] [actions]. The connector rail is drawn
    // by the nested <ul.tree-children>'s border-left; the horizontal tick
    // into this row is a CSS ::before on .tree-row when depth > 0. That way
    // the connector is real geometry, not a glyph that promises a line but
    // doesn't draw one.
    const dot = document.createElement('span')
    dot.className = 'tree-status-dot'
    const status = deriveStatus(node.entry)
    dot.dataset.status = status
    dot.title = statusTitle(status)
    li.appendChild(dot)

    const body = document.createElement('span')
    body.className = 'tree-row-body'
    const title = document.createElement('span')
    title.className = 'tree-row-title'
    // Fork/subagent children: never render the copied parent title verbatim
    // — the whole point of the row is "this is a branch off X at seq N", not
    // "here's the same title again". forkChildLabel derives the display text
    // from the fork point + the child's own signal.
    let info
    if (node.depth > 0) {
      const forkSeq = deriveForkSeq(node.entry)
      const label = globalThis.SessionTree.forkChildLabel(node.entry, parentEntry, forkSeq)
      info = { text: label.text, isUntitled: !label.hasOwnMessage }
      title.textContent = label.text
      title.title = label.hasOwnMessage
        ? `Fork of "${displayTitle(parentEntry)}" at seq ${forkSeq === null ? '?' : forkSeq}`
        : `Fork of "${displayTitle(parentEntry)}" · no new user messages yet`
    } else {
      info = titleInfo(node.entry)
      title.textContent = info.text
    }
    if (info.isUntitled) {
      title.classList.add('is-untitled')
      li.classList.add('is-untitled')
    }
    body.appendChild(title)
    if (node.entry.lastEventTime) {
      const rel = document.createElement('span')
      rel.className = 'tree-row-rel muted'
      rel.textContent = relTime(node.entry.lastEventTime)
      body.appendChild(rel)
    }
    li.appendChild(body)

    // Hover actions: three quiet buttons on the right that only appear when
    // the row is hovered/focused. They mirror the actions available in the
    // preview card so power users don't need to click into the preview.
    const actions = document.createElement('span')
    actions.className = 'tree-row-actions'
    actions.appendChild(makeQuietAction('open', 'Continue this session',
      '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" d="M3 8h9M8.5 4.5 12 8l-3.5 3.5"/></svg>'))
    actions.appendChild(makeQuietAction('fork', 'Fork from here',
      '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" d="M4.5 3.5v3a2 2 0 0 0 2 2h3a2 2 0 0 1 2 2v2M4.5 2.8a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4zm7 6.5a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4zm0-6.5a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4z"/></svg>'))
    actions.appendChild(makeQuietAction('compare', 'Compare branches (Shift-click a second row)',
      '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" d="M4 3v10M12 3v10M6.5 5.5h3M6.5 8h3M6.5 10.5h3"/></svg>'))
    li.appendChild(actions)

    if (node.entry.sessionId === state.selectedId) li.classList.add('is-selected')
    if (node.entry.sessionId === state.compareId) li.classList.add('is-compare')

    // stopPropagation: because children live inside the parent LI (so the
    // .tree-children rail hangs off the parent geometrically), a click on a
    // child row would bubble up and re-fire the parent's click handler, which
    // would then overwrite the child selection with the parent id. Stopping
    // propagation on the row itself keeps the innermost row wins.
    li.addEventListener('click', (ev) => {
      ev.stopPropagation()
      onRowClick(node.entry.sessionId, ev)
    })
    // Delegate action buttons — stopPropagation so a hover-action click
    // doesn't also trigger the row's select handler.
    for (const btn of actions.querySelectorAll('[data-quiet-action]')) {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation()
        void onQuietAction(node.entry.sessionId, btn.dataset.quietAction)
      })
    }

    container.appendChild(li)

    // Children go into a nested <ul.tree-children> whose border-left is the
    // vertical rail (solid for fork edges, dashed for subagent). The rail
    // is drawn by geometry, not by a placeholder span, so the legend's
    // "solid fork / dashed subagent" line matches what's on screen.
    if (Array.isArray(node.children) && node.children.length > 0) {
      const kids = document.createElement('ul')
      kids.className = 'tree-children'
      // Rail kind = kind of the FIRST child edge. In mixed-kind subtrees
      // (rare — you'd have to fork AND spawn a subagent from the same node)
      // the rail stays solid; individual rows still get their own tick
      // dashed via [data-edge="subagent"] on the child row.
      const firstChildKind = node.children[0].entry.header && node.children[0].entry.header.originKind === 'subagent'
        ? 'subagent' : 'fork'
      kids.dataset.railKind = firstChildKind
      for (const child of node.children) emitNode(kids, child, node.entry)
      // Nest kids INSIDE the parent li so the rail hangs off the parent row,
      // matching how git-branchless / gh CLI trees are drawn.
      li.appendChild(kids)
    }
  }

  // Derive the fork seq from the child's own header — seedLength is the
  // count of events replayed from the parent, so seedLength-1 is the highest
  // seq the child inherited. Falls back to null when missing so the label
  // reads "fork" without a seq (the older mock shape).
  function deriveForkSeq(entry) {
    const seed = entry && entry.header && entry.header.seedLength
    return typeof seed === 'number' && seed > 0 ? seed - 1 : null
  }

  function makeQuietAction(action, tip, svg) {
    const btn = document.createElement('button')
    btn.type = 'button'
    // Deliberately no `.ghost` class: the generic ghost button style adds a
    // 1px border and 6px/12px padding, which turns these into visible bordered
    // rounded rects even when the icon is transparent. The row-action class
    // owns its full appearance (24×24, no border, transparent background) so
    // hover-out is a clean fade to zero and the row stays quiet.
    btn.className = 'tree-row-action'
    btn.dataset.quietAction = action
    btn.title = tip
    btn.setAttribute('aria-label', tip)
    btn.innerHTML = svg
    return btn
  }

  function deriveStatus(entry) {
    if (!entry) return 'idle'
    if (entry.header && entry.header.awaitingApproval) return 'awaiting'
    if (entry.running) return 'running'
    // Best-effort: sessions that finished a turn recently but aren't running
    // read as "done" for the last hour, then decay to "idle" so old sessions
    // stop shouting at the user.
    if (entry.lastEventTime && (Date.now() - entry.lastEventTime) < 3600_000) return 'done'
    return 'idle'
  }

  function statusTitle(s) {
    return s === 'running' ? 'turn in flight'
      : s === 'awaiting' ? 'waiting for approval'
      : s === 'done' ? 'recently active'
      : 'idle'
  }

  // ---- selection + preview -------------------------------------------------

  function onRowClick(id, ev) {
    // Shift-click enters compare mode if the second pick shares a parent with
    // the current selection. Otherwise it's a plain select — clear compare.
    if (ev.shiftKey && state.selectedId && id !== state.selectedId) {
      if (canCompare(state.selectedId, id)) {
        state.compareId = id
        renderTree()
        renderCompare()
        return
      }
      // Fall through to plain select if compare isn't legal — the toolbar
      // button provides the affordance for users who don't know the rule.
    }
    select(id)
  }

  function canCompare(aId, bId) {
    const a = findEntry(aId)
    const b = findEntry(bId)
    if (!a || !b) return false
    const pa = a.header && a.header.parentSession
    const pb = b.header && b.header.parentSession
    // Same-parent branches — either both roots (pa/pb undefined) is not a
    // useful compare, so require a real shared parent.
    return !!pa && pa === pb
  }

  function select(id) {
    state.selectedId = id
    state.compareId = null
    renderTree()
    renderPreview()
  }

  async function onQuietAction(id, action) {
    if (action === 'open') {
      openInChat(id)
    } else if (action === 'fork') {
      await forkFromLatest(id)
    } else if (action === 'compare') {
      // No-op click on the compare glyph itself — the actual compare enters
      // via shift-click on a second row. Prime the title as a hint.
      state.selectedId = id
      renderTree()
      renderPreview()
      const tip = document.getElementById('tree-preview-title')
      if (tip) tip.title = 'Shift-click another row (same parent) to compare.'
    }
  }

  function openInChat(id) {
    // Switch to the chat pane and select the session there. This is what
    // "Open session" means everywhere in the app.
    if (window.__dshTabs) window.__dshTabs.switchTo('chat')
    if (window.__dshChat) void window.__dshChat.selectSession(id)
  }

  async function forkFromLatest(id) {
    try {
      const res = await window.dsh.forkSession({ sessionId: id })
      if (window.__dshChat) {
        await window.__dshChat.refreshSessionList()
        if (res && res.childSessionId) {
          // Land the user in the fresh child, but stay on the tree page —
          // it's the whole point of this surface. Select the child so the
          // preview updates too.
          state.selectedId = res.childSessionId
          renderTree()
          void renderPreview()
        }
      }
    } catch (err) {
      console.warn('[tree] fork failed', err && err.message)
    }
  }

  async function renderPreview() {
    const emptyEl = $('tree-preview-empty')
    const cardEl = $('tree-preview-card')
    const compareEl = $('tree-preview-compare')
    if (compareEl) compareEl.hidden = true
    const compareBtn = $('tree-compare-btn')

    if (!state.selectedId) {
      emptyEl.hidden = false
      cardEl.hidden = true
      if (compareBtn) compareBtn.disabled = true
      return
    }
    const entry = findEntry(state.selectedId)
    if (!entry) {
      emptyEl.hidden = false
      cardEl.hidden = true
      return
    }
    emptyEl.hidden = true
    cardEl.hidden = false

    $('tree-preview-title').textContent = displayTitle(entry)
    $('tree-preview-id').textContent = shortId(entry.sessionId)
    $('tree-preview-rel').textContent = relTime(entry.lastEventTime) || 'no activity'

    const statusWrap = $('tree-preview-status')
    const status = deriveStatus(entry)
    const dot = statusWrap.querySelector('.tree-status-dot')
    const label = statusWrap.querySelector('.tree-status-label')
    if (dot) dot.dataset.status = status
    if (label) label.textContent = statusTitle(status)

    $('tree-preview-cwd').textContent = (entry.header && entry.header.cwd) || '—'
    $('tree-preview-model').textContent = (entry.header && entry.header.model) || entry.model || '—'
    $('tree-preview-events').textContent = String(entry.eventCount || 0)

    // Context bar. The per-session tracker (context-meter.js) is the sole
    // source — Ticket B §B-3 (2026-07-16) deleted the old header-side
    // usage fallback because the wire never shipped a usage field on
    // SessionHeader. Background sessions with no tracker snapshot show
    // '—' below rather than 0, which is honest ("we haven't tracked this
    // yet") vs misleading ("this session has consumed 0% context").
    const meter = window.__dshContextMeter
    const chat = window.__dshChat
    let fraction = null
    if (chat && typeof chat.getEntries === 'function' && meter) {
      const snap = meter.snapshotFor && meter.snapshotFor(entry.sessionId)
      if (snap && typeof snap.fraction === 'number') fraction = snap.fraction
    }
    const bar = $('tree-preview-context').querySelector('.tree-context-fill')
    const cLabel = $('tree-preview-context').querySelector('.tree-context-label')
    if (fraction !== null) {
      bar.style.width = `${Math.min(100, Math.round(fraction * 100))}%`
      cLabel.textContent = `${Math.round(fraction * 100)}%`
    } else {
      // C-P1-4: `unknown` reads as "broken" to a first-time user. The real
      // reason is either "the turn hasn't been compacted yet" (in-flight or
      // just started) or "the daemon doesn't ship usageFraction for
      // background sessions". Give the count as evidence so the reader sees
      // it's not zero data — just not the ratio yet.
      bar.style.width = '0%'
      const n = Number(entry.eventCount || 0)
      cLabel.textContent = n > 0 ? `not compacted · ${n} event${n === 1 ? '' : 's'}` : 'not compacted'
    }

    // Timeline. Fetch events on demand; cache per-session to keep repeated
    // selections instant. Any error just leaves the empty state visible.
    const trackEl = $('tree-preview-timeline')
    await renderTimeline(entry.sessionId, trackEl)

    // Enable Compare toolbar button if this session has same-parent siblings.
    if (compareBtn) {
      const siblings = findSiblingCandidates(entry.sessionId)
      compareBtn.disabled = siblings.length === 0
      compareBtn.title = siblings.length === 0
        ? 'This session has no same-parent siblings to compare with.'
        : 'Select two same-parent branches to compare their timelines.'
    }
  }

  function findSiblingCandidates(id) {
    const entry = findEntry(id)
    if (!entry) return []
    const parent = entry.header && entry.header.parentSession
    if (!parent) return []
    return entries().filter((e) =>
      e && e.sessionId !== id
        && e.header && e.header.parentSession === parent)
  }

  async function fetchEvents(id) {
    if (state.eventCache.has(id)) return state.eventCache.get(id)
    try {
      const listing = await window.dsh.sessionEvents(id, {})
      const evs = (listing && Array.isArray(listing.events)) ? listing.events : []
      // Keep only what we need for the timeline: seq + type. Full payload
      // fetches are the chat pane's job.
      const trimmed = evs.map((e) => ({ seq: e.seq, type: e.type }))
      state.eventCache.set(id, trimmed)
      return trimmed
    } catch (_) {
      state.eventCache.set(id, [])
      return []
    }
  }

  async function renderTimeline(id, trackEl) {
    if (!trackEl) return
    trackEl.innerHTML = '<div class="tree-preview-timeline-empty muted">Loading…</div>'
    const evs = await fetchEvents(id)
    trackEl.innerHTML = ''
    if (evs.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'tree-preview-timeline-empty muted'
      empty.textContent = 'No events yet.'
      trackEl.appendChild(empty)
      return
    }
    // Fork boundaries: any child session's seedLength - 1 that falls inside
    // this session's event range shows up as a fork marker on the parent.
    const forkSeqs = new Set()
    for (const f of globalThis.SessionTree.findChildForks(id, entries())) {
      if (typeof f.forkSeq === 'number') forkSeqs.add(f.forkSeq)
    }
    const maxSeq = evs[evs.length - 1].seq || 1
    for (const e of evs) {
      const bucket = bucketFor(e.type)
      if (!bucket) continue
      const marker = document.createElement('span')
      marker.className = `tree-tl-marker tree-tl-marker--${bucket}`
      marker.style.left = `${Math.min(100, (e.seq / maxSeq) * 100)}%`
      marker.title = `${e.type} · seq ${e.seq}`
      trackEl.appendChild(marker)
    }
    for (const seq of forkSeqs) {
      const marker = document.createElement('span')
      marker.className = 'tree-tl-marker tree-tl-marker--fork'
      marker.style.left = `${Math.min(100, (seq / maxSeq) * 100)}%`
      marker.title = `fork boundary · seq ${seq}`
      trackEl.appendChild(marker)
    }
  }

  function bucketFor(type) {
    const kind = globalThis.SessionTree.classifyEvent({ type })
    if (kind === 'turn-boundary') return 'turn'
    if (kind === 'tool-call' || kind === 'tool-result') return 'tool'
    if (kind === 'compact-begin' || kind === 'compact-end' || kind === 'compact-summary') return 'compact'
    return null
  }

  // ---- compare mode --------------------------------------------------------

  async function renderCompare() {
    const emptyEl = $('tree-preview-empty')
    const cardEl = $('tree-preview-card')
    const compareEl = $('tree-preview-compare')
    if (!compareEl) return
    if (!state.selectedId || !state.compareId) {
      compareEl.hidden = true
      return
    }
    emptyEl.hidden = true
    cardEl.hidden = true
    compareEl.hidden = false

    const left = findEntry(state.selectedId)
    const right = findEntry(state.compareId)
    if (!left || !right) return
    $('tree-compare-left-title').textContent = displayTitle(left)
    $('tree-compare-right-title').textContent = displayTitle(right)
    $('tree-compare-left-sub').textContent = `${shortId(left.sessionId)} · ${relTime(left.lastEventTime)}`
    $('tree-compare-right-sub').textContent = `${shortId(right.sessionId)} · ${relTime(right.lastEventTime)}`

    await renderTimeline(left.sessionId, $('tree-compare-left-timeline'))
    await renderTimeline(right.sessionId, $('tree-compare-right-timeline'))
  }

  // ---- wiring --------------------------------------------------------------

  function wireStaticButtons() {
    const openBtn = $('tree-preview-open')
    if (openBtn) openBtn.addEventListener('click', () => {
      if (state.selectedId) openInChat(state.selectedId)
    })
    const forkBtn = $('tree-preview-fork')
    if (forkBtn) forkBtn.addEventListener('click', () => {
      if (state.selectedId) void forkFromLatest(state.selectedId)
    })
    const compareBtn = $('tree-compare-btn')
    if (compareBtn) compareBtn.addEventListener('click', () => {
      // Guided compare-mode entry: prompt the user via the preview title's
      // title attribute and highlight sibling rows so they know what to
      // shift-click. If there's exactly one sibling, enter compare
      // immediately (single obvious choice).
      if (!state.selectedId) return
      const siblings = findSiblingCandidates(state.selectedId)
      if (siblings.length === 1) {
        state.compareId = siblings[0].sessionId
        renderTree()
        void renderCompare()
        return
      }
      // Otherwise flag the candidates visibly.
      renderTree()
      for (const s of siblings) {
        const row = document.querySelector(`.tree-row[data-session-id="${cssEscapeId(s.sessionId)}"]`)
        if (row) row.classList.add('is-compare-candidate')
      }
    })
    const compareClose = $('tree-compare-close')
    if (compareClose) compareClose.addEventListener('click', () => {
      state.compareId = null
      renderTree()
      renderPreview()
    })
    const refreshBtn = $('tree-refresh')
    if (refreshBtn) refreshBtn.addEventListener('click', () => {
      state.eventCache.clear()
      if (window.__dshChat) {
        void window.__dshChat.refreshSessionList().then(() => {
          renderTree()
          void renderPreview()
        })
      } else {
        renderTree()
        void renderPreview()
      }
    })
  }

  function cssEscapeId(id) {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(id)
    return String(id).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c.charCodeAt(0).toString(16) + ' ')
  }

  // Public surface — renderer.js calls render() when the user opens the tab.
  window.__dshTree = {
    render() {
      renderTree()
      void renderPreview()
    },
    // QA hook: force the demo forest without needing the empty-state button
    // (once real sessions exist, the "Load demo tree" button never shows).
    // Used by scripts/qa-cdp-shoot-demo-labels.mjs to verify the demo-forest
    // chip renders. Not called by product code.
    _loadDemoForQA() { loadDemoTree() },
    _clearDemoForQA() {
      state.demoEntries = null
      state.selectedId = null
      renderTree()
      void renderPreview()
    },
  }

  // Wire up static buttons after the DOM is ready. The controller script sits
  // at the end of index.html so DOMContentLoaded has usually fired; use a
  // guard for the rare case where it hasn't.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireStaticButtons, { once: true })
  } else {
    wireStaticButtons()
  }
})()
