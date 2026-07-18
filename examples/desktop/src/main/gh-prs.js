// Pull Requests data source — thin wrapper over the `gh` CLI.
//
// The desktop shell adopts Codex's PR page pattern: a scrollable list of PRs
// across the current repo, with state dots, branch names, and diff totals.
// We can either shell out to `gh pr list --json …` (the Just-Works path when
// the user is already signed in with GitHub CLI) or fall back to a demo
// dataset when gh is missing or unauthenticated. Both paths produce the same
// normalized row shape so the renderer never branches on data source.
//
// The module is deliberately pure — no direct dependency on Electron, no
// side-effectful timers — so `node --test` can exercise every transform
// without spawning a real gh. The tiny amount of I/O (execFile) is injected
// by the caller, mirroring how test/plugin-probe.test.js drives its child
// spawns.

'use strict'

const { execFile } = require('node:child_process')

// GUI-launched Electron inherits launchd's minimal PATH (no /opt/homebrew/bin,
// no /usr/local/bin), so `gh` resolves to ENOENT even when installed. Extend
// PATH for every gh spawn instead of asking users to launch from a terminal.
const GH_ENV = {
  ...process.env,
  PATH: ['/opt/homebrew/bin', '/usr/local/bin', process.env.PATH || ''].join(':'),
}


// Fields we ask gh for. Ordering matches how we render columns; leaving the
// list narrow keeps the JSON reply small (a shell with 30 open PRs stays
// under a few KB) and matches what the row transform actually reads.
const GH_JSON_FIELDS = [
  'number', 'title', 'state', 'isDraft',
  'headRefName', 'baseRefName',
  'updatedAt', 'createdAt',
  'additions', 'deletions',
  'author', 'url', 'mergeable',
].join(',')

/**
 * Detect whether `gh` is available and authenticated. Runs `gh auth status`
 * which exits 0 iff there's a logged-in host. We treat `gh --version` alone
 * as insufficient because a stale install with no auth still exits 0 there
 * and then the pr-list call fails opaquely.
 *
 * @param {{execFile?: typeof execFile}} deps
 * @returns {Promise<{available: boolean, reason?: string}>}
 */
function detectGh(deps = {}) {
  const run = deps.execFile || execFile
  return new Promise((resolve) => {
    run('gh', ['auth', 'status'], { timeout: 3000, env: GH_ENV }, (err, _stdout, stderr) => {
      if (err) {
        // ENOENT → gh binary is not on PATH. Any other error we treat as
        // "installed but not usable" so the UI shows the connect-hint.
        const reason = err.code === 'ENOENT'
          ? 'gh CLI not found on PATH'
          : (stderr || err.message || '').toString().trim().split('\n')[0]
        resolve({ available: false, reason: reason || 'gh auth failed' })
        return
      }
      resolve({ available: true })
    })
  })
}

/**
 * Run `gh pr list` against the given repo directory. `cwd` is any directory
 * inside a repo gh recognizes (it walks up for .git). We limit to 30 rows —
 * a Codex-style list is scannable up to about that many; anything beyond
 * belongs in the web UI.
 *
 * @param {{cwd: string, limit?: number, execFile?: typeof execFile}} opts
 * @returns {Promise<{rows: object[], repo?: string, error?: string}>}
 */
function listPRs(opts) {
  if (!opts || typeof opts.cwd !== 'string') {
    return Promise.reject(new Error('listPRs needs { cwd }'))
  }
  const run = opts.execFile || execFile
  const limit = Math.max(1, Math.min(100, opts.limit || 30))
  const args = [
    'pr', 'list',
    '--limit', String(limit),
    '--state', 'all',
    '--json', GH_JSON_FIELDS,
  ]
  return new Promise((resolve, reject) => {
    run('gh', args, { cwd: opts.cwd, timeout: 10000, maxBuffer: 4 * 1024 * 1024, env: GH_ENV },
      (err, stdout, stderr) => {
        if (err) {
          // Normalize the "not a repo" / "not authed" cases so the renderer
          // can degrade gracefully; other errors still bubble.
          const msg = (stderr || err.message || '').toString()
          reject(Object.assign(new Error(msg.trim() || 'gh pr list failed'), {
            code: err.code,
            stderr: msg,
          }))
          return
        }
        let parsed
        try { parsed = JSON.parse(stdout || '[]') }
        catch (parseErr) {
          reject(new Error(`gh pr list: JSON parse failed: ${parseErr.message}`))
          return
        }
        if (!Array.isArray(parsed)) {
          reject(new Error('gh pr list: expected JSON array'))
          return
        }
        resolve({ rows: parsed.map(normalizePRRow) })
      })
  })
}

/**
 * Detect the owner/repo slug for a repo directory. `gh repo view --json …`
 * is the source of truth even in worktrees.
 *
 * @param {{cwd: string, execFile?: typeof execFile}} opts
 * @returns {Promise<string|null>}
 */
function detectRepo(opts) {
  if (!opts || typeof opts.cwd !== 'string') return Promise.resolve(null)
  const run = opts.execFile || execFile
  return new Promise((resolve) => {
    run('gh', ['repo', 'view', '--json', 'nameWithOwner'],
      { cwd: opts.cwd, timeout: 3000 , env: GH_ENV },
      (err, stdout) => {
        if (err) { resolve(null); return }
        try {
          const parsed = JSON.parse(stdout)
          resolve(parsed && typeof parsed.nameWithOwner === 'string' ? parsed.nameWithOwner : null)
        } catch (_) { resolve(null) }
      })
  })
}

/**
 * Turn a gh JSON row into the normalized shape the renderer expects. Pure —
 * every field is derived from the input so test/gh-prs.test.js can lock the
 * contract without spawning gh.
 *
 * `stateDot` is one of:
 *   - `open`     — open, not draft, no known conflict
 *   - `draft`    — open + isDraft
 *   - `conflict` — open + mergeable === 'CONFLICTING'
 *   - `merged`   — merged
 *   - `closed`   — closed without merge
 * Everything unknown collapses to `open` (safer than hiding a row).
 */
function normalizePRRow(raw) {
  if (!raw || typeof raw !== 'object') {
    return { number: 0, title: '(malformed)', stateDot: 'closed', dropped: true }
  }
  const state = String(raw.state || 'OPEN').toUpperCase()
  const isDraft = !!raw.isDraft
  const mergeable = String(raw.mergeable || '').toUpperCase()
  let stateDot = 'open'
  if (state === 'MERGED') stateDot = 'merged'
  else if (state === 'CLOSED') stateDot = 'closed'
  else if (isDraft) stateDot = 'draft'
  else if (mergeable === 'CONFLICTING') stateDot = 'conflict'
  return {
    number: Number(raw.number) || 0,
    title: String(raw.title || '').trim() || '(untitled)',
    state, // OPEN | CLOSED | MERGED
    isDraft,
    stateDot,
    headRefName: String(raw.headRefName || ''),
    baseRefName: String(raw.baseRefName || ''),
    updatedAt: String(raw.updatedAt || ''),
    createdAt: String(raw.createdAt || ''),
    additions: Number(raw.additions) || 0,
    deletions: Number(raw.deletions) || 0,
    authorLogin: raw.author && typeof raw.author === 'object'
      ? String(raw.author.login || '')
      : (typeof raw.author === 'string' ? raw.author : ''),
    url: String(raw.url || ''),
  }
}

/**
 * Format an ISO timestamp as a compact relative label. Under a minute reads
 * "just now"; under an hour "5m"; under a day "3h"; else "2d"/"3w". Mirrors
 * the Codex list's density — one glyph-cluster wide in the row.
 *
 * @param {string|Date} iso
 * @param {Date} [now]
 */
function formatRelativeTime(iso, now = new Date()) {
  if (!iso) return ''
  const t = typeof iso === 'string' ? Date.parse(iso) : iso instanceof Date ? iso.getTime() : NaN
  if (!Number.isFinite(t)) return ''
  const diff = Math.max(0, now.getTime() - t) // ms
  const s = Math.floor(diff / 1000)
  if (s < 45) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d`
  const w = Math.floor(d / 7)
  if (w < 5) return `${w}w`
  const mo = Math.floor(d / 30)
  if (mo < 12) return `${mo}mo`
  const y = Math.floor(d / 365)
  return `${y}y`
}

/**
 * Filter and group a normalized row list by the user's filter selection.
 * `filter` is 'all' | 'open' | 'mine'. `viewer` is optional — when supplied
 * and filter='mine', only rows whose authorLogin matches survive.
 *
 * Grouping produces { open: [...], closed: [...] } — Codex's layout puts
 * open above closed with a small "Recently merged/closed" header. When
 * filter='open' the closed bucket is empty.
 *
 * @param {object[]} rows
 * @param {{filter?: 'all'|'open'|'mine', viewer?: string}} [opts]
 */
function filterAndGroup(rows, opts = {}) {
  const filter = opts.filter || 'all'
  const viewer = (opts.viewer || '').toLowerCase()
  const keep = (r) => {
    if (r.dropped) return false
    if (filter === 'open') return r.state === 'OPEN'
    if (filter === 'mine') return viewer && r.authorLogin && r.authorLogin.toLowerCase() === viewer
    return true
  }
  const kept = rows.filter(keep)
  return {
    open: kept.filter((r) => r.state === 'OPEN'),
    closed: kept.filter((r) => r.state !== 'OPEN'),
    total: kept.length,
  }
}

// Deterministic demo dataset. Used when `gh` is unavailable/unauth so the
// PR page still renders something illustrative and the "connect gh CLI"
// hint can point the user at what to do next. Numbers/titles reflect what
// the real deepseek-harness repo would show — matching format keeps the
// screenshot honest for demo purposes.
const DEMO_ROWS = [
  {
    number: 349, title: 'docs(rfc): propose harness-level goal-based loop',
    state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE',
    headRefName: 'rfc/goal-loop', baseRefName: 'master',
    updatedAt: '', createdAt: '', additions: 412, deletions: 8,
    author: { login: 'demo-author-a' }, url: 'https://github.com/deepseek-harness/deepseek-harness/pull/349',
  },
  {
    number: 348, title: 'docs(i18n): restore prompt-v4 as the pipeline baseline',
    state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE',
    headRefName: 'i18n/prompt-v4-restore', baseRefName: 'master',
    updatedAt: '', createdAt: '', additions: 132, deletions: 47,
    author: { login: 'demo-author-a' }, url: 'https://github.com/deepseek-harness/deepseek-harness/pull/348',
  },
  {
    number: 347, title: 'feat(jsonrpc): protocol v2 — session lifecycle + capability negotiation',
    state: 'OPEN', isDraft: false, mergeable: 'CONFLICTING',
    headRefName: 'feat/jsonrpc-v2', baseRefName: 'master',
    updatedAt: '', createdAt: '', additions: 1893, deletions: 271,
    author: { login: 'demo-author-b' }, url: 'https://github.com/deepseek-harness/deepseek-harness/pull/347',
  },
  {
    number: 342, title: 'docs(rfc): recallable compaction primer',
    state: 'MERGED', isDraft: false, mergeable: 'MERGEABLE',
    headRefName: 'rfc/recallable-compaction', baseRefName: 'master',
    updatedAt: '', createdAt: '', additions: 289, deletions: 3,
    author: { login: 'demo-author-a' }, url: 'https://github.com/deepseek-harness/deepseek-harness/pull/342',
  },
  {
    number: 340, title: 'feat(desktop): quick-chat overlay + PR list surface',
    state: 'OPEN', isDraft: true, mergeable: 'MERGEABLE',
    headRefName: 'demo/desktop-shell', baseRefName: 'master',
    updatedAt: '', createdAt: '', additions: 640, deletions: 12,
    author: { login: 'demo-author-a' }, url: 'https://github.com/deepseek-harness/deepseek-harness/pull/340',
  },
]

/**
 * Return a demo dataset backfilled with plausible timestamps around `now` so
 * the UI's relative-time labels vary ("just now" through "5d"). Each call
 * yields fresh timestamps — cache the result if you want stability.
 *
 * @param {Date} [now]
 */
function demoRows(now = new Date()) {
  const t = now.getTime()
  const spans = [3 * 60 * 1000, 45 * 60 * 1000, 4 * 3600 * 1000, 26 * 3600 * 1000, 5 * 86400 * 1000]
  return DEMO_ROWS.map((row, i) => normalizePRRow({
    ...row,
    updatedAt: new Date(t - spans[i % spans.length]).toISOString(),
    createdAt: new Date(t - spans[i % spans.length] - 12 * 3600 * 1000).toISOString(),
  }))
}


// Who is the authenticated gh user? Used by the PR page's "mine" filter.
// Lives here (not in main.js) so the spawn inherits GH_ENV — a
// GUI-launched Electron gets launchd's minimal PATH and a bare execFile
// would ENOENT even with gh installed (same trap the docblock at the top
// of this file describes; drift D37).
function detectViewer() {
  return new Promise((resolve) => {
    run('gh', ['api', 'user', '-q', '.login'], { timeout: 3000, env: GH_ENV },
      (err, stdout) => resolve(err ? '' : String(stdout || '').trim()))
  })
}

module.exports = {
  detectViewer,
  detectGh,
  detectRepo,
  listPRs,
  normalizePRRow,
  formatRelativeTime,
  filterAndGroup,
  demoRows,
}
