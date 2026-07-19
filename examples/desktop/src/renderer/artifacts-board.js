// Artifact panel views: Board grid + Timeline list + Evolution chain.
//
// The compact L0 row (density-spec §2, artifacts.js) is the default List
// view. This module adds two more projections of the same event stream:
//
//   * Board  — group by kind (md / html / svg / json / code / other),
//              each group a tile grid with thumbnails. Good when the
//              front-end task is producing several files and you want to
//              see "what's ready" at a glance rather than scroll rows.
//   * Timeline — chronological, one row per artifact-version tuple, so
//              you can watch "which file changed when" over the session.
//
// Plus the version-evolution chain: clicking a `.artifact-version` chip
// on any List row expands an inline strip listing every version this
// artifact has seen, with a per-hop diff pane. The chain is fed from
// state.history[artifactId] which artifacts.js maintains as events arrive.
//
// Runtime constraint: the artifact server only serves the CURRENT file
// contents (see src/main/artifact-server.js — no per-version blob store).
// This module accepts an optional `blob` field on history entries so the
// fixture can demo real diffs; when absent, the pre-latest hops render a
// "content not preserved for older versions" placeholder — an honest
// signal that the diff is fixture-tier until the runtime seam grows a
// snapshot store (RFC follow-up).

'use strict'

;(function () {
  const KINDS = ['md', 'html', 'svg', 'json', 'code', 'other']
  const KIND_LABEL = {
    md: 'Markdown', html: 'HTML', svg: 'SVG', json: 'JSON',
    code: 'Code', other: 'Other',
  }
  // Mirrors artifacts.js's ICON_SVG shape — inline stroke icons keep the
  // Board tiles consistent with the row icons on the List view.
  const KIND_ICON = {
    md:
      '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">'
      + '<path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" '
      + 'd="M11 3H5.5A1.5 1.5 0 0 0 4 4.5v11A1.5 1.5 0 0 0 5.5 17h9a1.5 1.5 0 0 0 1.5-1.5V8zM11 3v4a1 1 0 0 0 1 1h4M7 11h6M7 13h4"/>'
      + '</svg>',
    html:
      '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">'
      + '<path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" '
      + 'd="M11 3H5.5A1.5 1.5 0 0 0 4 4.5v11A1.5 1.5 0 0 0 5.5 17h9a1.5 1.5 0 0 0 1.5-1.5V8zM11 3v4a1 1 0 0 0 1 1h4"/>'
      + '</svg>',
    svg:
      '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">'
      + '<rect x="3" y="4" width="14" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/>'
      + '<circle cx="7" cy="8" r="1.4" fill="none" stroke="currentColor" stroke-width="1.4"/>'
      + '<path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="M4 14l4-4 3 3 3-3 3 3"/>'
      + '</svg>',
    json:
      '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">'
      + '<path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" '
      + 'd="M8 3H5.5A1.5 1.5 0 0 0 4 4.5v11A1.5 1.5 0 0 0 5.5 17H8M12 3h2.5A1.5 1.5 0 0 1 16 4.5v11a1.5 1.5 0 0 1-1.5 1.5H12"/>'
      + '</svg>',
    code:
      '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">'
      + '<path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" '
      + 'd="M7 6l-4 4 4 4M13 6l4 4-4 4M11 4l-2 12"/>'
      + '</svg>',
    other:
      '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">'
      + '<path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" '
      + 'd="M14.5 8.5 8 15a3 3 0 0 1-4.2-4.2l7-7a2 2 0 0 1 2.8 2.8L7.5 12.5a1 1 0 0 1-1.4-1.4L12 5.5"/>'
      + '</svg>',
  }

  // Normalize the free-form `kind` value each event carries into one of
  // the six Board buckets — HTML from real artifacts sometimes arrives as
  // 'html', 'htm', 'text/html'; keep the mapping generous.
  function bucketOf(kind) {
    if (!kind) return 'other'
    const k = String(kind).toLowerCase()
    if (k.includes('md') || k.includes('markdown')) return 'md'
    if (k.includes('svg')) return 'svg'
    if (k.includes('html') || k.includes('htm')) return 'html'
    if (k.includes('json')) return 'json'
    if (['js', 'ts', 'py', 'go', 'rs', 'sh', 'c', 'cpp', 'rb', 'java'].some((x) => k === x || k.includes(x))) return 'code'
    return 'other'
  }

  function groupByKind(entries) {
    const groups = new Map()
    for (const k of KINDS) groups.set(k, [])
    for (const e of entries) {
      const b = bucketOf(e.kind)
      groups.get(b).push(e)
    }
    // Drop empty buckets so the Board doesn't render empty group headers
    // when a session has only produced markdown, etc.
    for (const k of KINDS) {
      if (groups.get(k).length === 0) groups.delete(k)
    }
    return groups
  }

  function firstLine(text) {
    if (!text) return ''
    const nl = text.indexOf('\n')
    return (nl < 0 ? text : text.slice(0, nl)).trim()
  }

  // Build a small text preview for the tile: MD → first non-blank line;
  // JSON → first two keys; code → first two non-blank lines; SVG/HTML
  // fall back to the filename since a code preview isn't legible.
  function thumbnailPreview(entry) {
    const b = bucketOf(entry.kind)
    const blob = entry.blob || ''
    if (b === 'md') return firstLine(blob) || entry.artifactId
    if (b === 'json') {
      try {
        const parsed = JSON.parse(blob)
        const keys = Object.keys(parsed).slice(0, 3)
        return keys.length ? '{ ' + keys.join(', ') + ' }' : entry.artifactId
      } catch {
        return firstLine(blob) || entry.artifactId
      }
    }
    if (b === 'code') {
      const lines = blob.split('\n').filter((l) => l.trim()).slice(0, 3)
      return lines.join('\n') || entry.artifactId
    }
    if (b === 'html') return firstLine(blob.replace(/<[^>]+>/g, ' ')) || entry.artifactId
    return ''
  }

  // Board renderer: one <section class="artifact-board-group"> per kind
  // bucket, containing a grid of `.artifact-tile` cards. Clicking a tile
  // opens the artifact in the system browser (same seam as the L0
  // `open ↗` link on the List view).
  function renderBoard(entries, opts) {
    const openArtifact = (opts && opts.openArtifact) || (() => {})
    const el = document.createElement('div')
    el.className = 'artifact-board'
    const groups = groupByKind(entries)
    for (const [kind, group] of groups) {
      const section = document.createElement('section')
      section.className = 'artifact-board-group'
      section.dataset.kind = kind
      const head = document.createElement('header')
      head.className = 'artifact-board-group-head'
      const icon = document.createElement('span')
      icon.className = 'artifact-board-group-icon'
      icon.innerHTML = KIND_ICON[kind] || KIND_ICON.other
      const title = document.createElement('span')
      title.className = 'artifact-board-group-title'
      title.textContent = KIND_LABEL[kind] || kind
      const count = document.createElement('span')
      count.className = 'artifact-board-group-count'
      count.textContent = String(group.length)
      head.append(icon, title, count)
      section.append(head)

      const grid = document.createElement('div')
      grid.className = 'artifact-board-grid'
      for (const entry of group) {
        grid.appendChild(renderTile(entry, openArtifact))
      }
      section.append(grid)
      el.append(section)
    }
    return el
  }

  function renderTile(entry, openArtifact) {
    const tile = document.createElement('button')
    tile.type = 'button'
    tile.className = 'artifact-tile'
    tile.dataset.artifactId = entry.artifactId
    tile.dataset.kind = bucketOf(entry.kind)
    tile.setAttribute('aria-label', `Open ${entry.artifactId} v${entry.version || 1} in browser`)
    tile.addEventListener('click', (e) => {
      e.preventDefault()
      Promise.resolve().then(() => openArtifact(entry.artifactId))
    })
    const thumb = document.createElement('div')
    thumb.className = 'artifact-thumb'
    thumb.dataset.kind = bucketOf(entry.kind)
    const preview = thumbnailPreview(entry)
    if (preview) {
      const pre = document.createElement('pre')
      pre.className = 'artifact-thumb-text'
      pre.textContent = preview
      thumb.append(pre)
    } else {
      const icon = document.createElement('span')
      icon.className = 'artifact-thumb-icon'
      icon.innerHTML = KIND_ICON[bucketOf(entry.kind)] || KIND_ICON.other
      thumb.append(icon)
    }
    const meta = document.createElement('div')
    meta.className = 'artifact-tile-meta'
    const name = document.createElement('span')
    name.className = 'artifact-tile-name'
    name.textContent = entry.artifactId
    name.title = entry.path || entry.artifactId
    const ver = document.createElement('span')
    ver.className = 'artifact-tile-version'
    ver.textContent = `v${entry.version || 1}`
    meta.append(name, ver)
    tile.append(thumb, meta)
    return tile
  }

  // Timeline renderer: chronological (newest first), one row per
  // artifact-version tuple pulled from `history`. Each row shows kind,
  // name, version, and a relative timestamp — good for auditing
  // "when did which file mutate" during a long session.
  function renderTimeline(entries, opts) {
    const openArtifact = (opts && opts.openArtifact) || (() => {})
    const history = (opts && opts.history) || new Map()
    const el = document.createElement('div')
    el.className = 'artifact-timeline'

    // Flatten history into a single sorted stream.
    const events = []
    for (const entry of entries) {
      const hist = history.get(entry.artifactId) || [{
        artifactId: entry.artifactId,
        version: entry.version || 1,
        seenAt: entry.seenAt || Date.now(),
        kind: entry.kind,
        path: entry.path,
      }]
      for (const h of hist) events.push({ ...h, kind: h.kind || entry.kind, path: h.path || entry.path })
    }
    events.sort((a, b) => (b.seenAt || 0) - (a.seenAt || 0))
    for (const ev of events) {
      const row = document.createElement('div')
      row.className = 'artifact-timeline-row'
      row.dataset.artifactId = ev.artifactId
      row.dataset.version = String(ev.version)
      const stamp = document.createElement('span')
      stamp.className = 'artifact-timeline-time'
      stamp.textContent = formatRelative(ev.seenAt)
      stamp.title = new Date(ev.seenAt).toISOString()
      const icon = document.createElement('span')
      icon.className = 'artifact-timeline-icon'
      icon.innerHTML = KIND_ICON[bucketOf(ev.kind)] || KIND_ICON.other
      const name = document.createElement('span')
      name.className = 'artifact-timeline-name'
      name.textContent = ev.artifactId
      const ver = document.createElement('span')
      ver.className = 'artifact-timeline-version'
      ver.textContent = `v${ev.version}`
      const openLink = document.createElement('a')
      openLink.className = 'artifact-timeline-open'
      openLink.href = '#'
      openLink.textContent = 'open ↗'
      openLink.addEventListener('click', (e) => {
        e.preventDefault()
        Promise.resolve().then(() => openArtifact(ev.artifactId))
      })
      row.append(stamp, icon, name, ver, openLink)
      el.append(row)
    }
    return el
  }

  function formatRelative(ts) {
    if (!ts) return ''
    const delta = Date.now() - ts
    if (delta < 60_000) return 'just now'
    if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`
    if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`
    return `${Math.round(delta / 86_400_000)}d ago`
  }

  // Evolution chain: N version records → N-1 inter-version diff panes.
  // Each hop is a `<details>` collapsed by default (opens on click) so a
  // long history doesn't dominate vertical space. The pane body renders
  // a naïve line-diff — pre-latest hops fall back to a "content not
  // preserved" placeholder when no `blob` field is available (the real
  // runtime doesn't retain older blobs; the fixture provides them).
  function renderEvolution(entry, history) {
    const chain = (history || []).slice().sort((a, b) => (a.version || 0) - (b.version || 0))
    const el = document.createElement('div')
    el.className = 'artifact-evolution'
    el.dataset.artifactId = entry.artifactId

    const head = document.createElement('div')
    head.className = 'artifact-evolution-head'
    const label = document.createElement('span')
    label.className = 'artifact-evolution-label'
    label.textContent = 'evolution'
    const summary = document.createElement('span')
    summary.className = 'artifact-evolution-summary'
    const versions = chain.map((c) => `v${c.version}`).join(' → ')
    summary.textContent = versions || `v${entry.version || 1}`
    head.append(label, summary)
    el.append(head)

    // Provenance banner: the real ArtifactServer broadcasts fs writes
    // with no blob content, so per-hop diffs collapse to the "content
    // not preserved" fallback in production. When any hop is missing
    // blob content we surface why up front rather than letting the
    // researcher assume the diff pane is broken. Fixture supplies
    // blobs so all hops render; production doesn't, yet.
    const missingBlobs = chain.some((c) => typeof c.blob !== 'string')
    if (missingBlobs) {
      const banner = document.createElement('div')
      banner.className = 'artifact-evolution-banner muted small'
      banner.textContent = 'Version diff currently requires blob payload. The real ArtifactServer does not preserve older blobs (RFC L-3 follow-up: snapshot store). The fixture supplies blobs for demo.'
      el.append(banner)
    }

    const chainEl = document.createElement('ol')
    chainEl.className = 'artifact-evolution-chain'
    for (let i = 0; i < chain.length; i++) {
      const step = chain[i]
      const stepEl = document.createElement('li')
      stepEl.className = 'artifact-evolution-step'
      stepEl.dataset.version = String(step.version)
      const stepHead = document.createElement('div')
      stepHead.className = 'artifact-evolution-step-head'
      const ver = document.createElement('span')
      ver.className = 'artifact-evolution-step-ver'
      ver.textContent = `v${step.version}`
      const stamp = document.createElement('span')
      stamp.className = 'artifact-evolution-step-time muted'
      stamp.textContent = formatRelative(step.seenAt)
      stepHead.append(ver, stamp)
      stepEl.append(stepHead)

      if (i > 0) {
        const prev = chain[i - 1]
        const diffPane = renderDiffPane(prev, step)
        stepEl.append(diffPane)
      } else {
        const seedNote = document.createElement('div')
        seedNote.className = 'artifact-evolution-seed muted'
        seedNote.textContent = 'initial version'
        stepEl.append(seedNote)
      }
      chainEl.append(stepEl)
    }
    el.append(chainEl)
    return el
  }

  function renderDiffPane(prev, next) {
    const pane = document.createElement('details')
    pane.className = 'artifact-evolution-diff'
    pane.open = false
    const sum = document.createElement('summary')
    sum.className = 'artifact-evolution-diff-summary'
    sum.textContent = `diff v${prev.version} → v${next.version}`
    pane.append(sum)

    // If either side is missing a blob, we can't compute a diff. This is
    // the honest state for the real runtime (older blobs aren't cached).
    if (!prev.blob || !next.blob) {
      const note = document.createElement('div')
      note.className = 'artifact-evolution-diff-note muted'
      note.textContent = 'content for older versions is not preserved by the artifact server — diff unavailable'
      pane.append(note)
      return pane
    }
    const result = diffLines(prev.blob, next.blob)
    if (result && result.note) {
      const note = document.createElement('div')
      note.className = 'artifact-evolution-diff-note muted'
      note.textContent = result.note
      pane.append(note)
      return pane
    }
    const diffEl = document.createElement('div')
    diffEl.className = 'artifact-evolution-diff-body'
    const lines = Array.isArray(result) ? result : []
    for (const ln of lines) {
      const row = document.createElement('div')
      row.className = `artifact-evolution-diff-line kind-${ln.kind}`
      const gutter = document.createElement('span')
      gutter.className = 'artifact-evolution-diff-gutter'
      gutter.textContent = ln.kind === 'add' ? '+' : ln.kind === 'del' ? '-' : ' '
      const body = document.createElement('span')
      body.className = 'artifact-evolution-diff-text'
      body.textContent = ln.text
      row.append(gutter, body)
      diffEl.append(row)
    }
    pane.append(diffEl)
    return pane
  }

  // Line-level diff, LCS-style. Kept tiny on purpose — the artifact
  // demo isn't a git-scale diff engine and blobs here are small
  // (single-page HTML, short markdown). For big files we'd swap in
  // tool-cards.js's diffLines(); this is deliberately dependency-free
  // so the module unit tests don't have to boot the whole renderer.
  function diffLines(a, b) {
    const aLines = a.split('\n')
    const bLines = b.split('\n')
    const n = aLines.length
    const m = bLines.length
    // Blobs from real artifacts are bounded by the demo (single-page HTML,
    // short markdown), but nothing in the pipe enforces that — a fixture
    // or user-flagged file can be much larger. LCS is O(n·m) space and
    // time, so we bail out on anything that would allocate over a small
    // Int32 grid. The caller renders a "diff omitted" note in place of
    // the pane. Threshold picked so 1e6 cells ≈ 4MB Int32 stays comfortable
    // in the renderer heap.
    if (n * m > 1e6 || n > 5000 || m > 5000) {
      return { note: 'diff omitted (blob too large)', add: 0, del: 0 }
    }
    const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        if (aLines[i] === bLines[j]) dp[i][j] = dp[i + 1][j + 1] + 1
        else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1])
      }
    }
    const out = []
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (aLines[i] === bLines[j]) {
        out.push({ kind: 'ctx', text: aLines[i] })
        i++
        j++
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        out.push({ kind: 'del', text: aLines[i] })
        i++
      } else {
        out.push({ kind: 'add', text: bLines[j] })
        j++
      }
    }
    while (i < n) { out.push({ kind: 'del', text: aLines[i++] }) }
    while (j < m) { out.push({ kind: 'add', text: bLines[j++] }) }
    return out
  }

  const api = {
    KINDS,
    bucketOf,
    groupByKind,
    renderBoard,
    renderTimeline,
    renderEvolution,
    thumbnailPreview,
    diffLines,
    formatRelative,
  }

  // Dual export: CommonJS for node:test (test/artifact-evolution-board.test.js
  // asserts on the module surface without booting Electron), window for
  // the renderer to consume via artifacts.js. Mirrors the pattern used by
  // tool-cards.js and widgets.js.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api
  }
  if (typeof window !== 'undefined') {
    window.__dshArtifactsBoard = api
  }
})()
