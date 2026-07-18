// Static gate for the centered-card ban (density-spec §7; user re-flagged
// 2026-07-17, second occurrence). Every in-stream element is a full-width,
// left-aligned row that expands INLINE. The forbidden CSS smells are
// `margin: * auto` and `align-self: center` on the tool-card / trigger /
// steer families; both survived one dedicated sweep before drift caught
// them, so we lock the ban at the test layer instead of relying on eyes.
//
// Exemption list (must stay allowed to use auto/center):
//   .empty-welcome            — first-boot empty-state page chrome
//   .empty-launcher           — launcher grid page chrome
//   .context-page-empty-*     — Context page empty state (page chrome)
//   .msg.user                 — canonical user-bubble right-anchor
//                               (`margin-left: auto` is the shape, not a smell)
'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const cssPath = path.resolve(__dirname, '..', 'src', 'renderer', 'style.css')
const css = fs.readFileSync(cssPath, 'utf8')

// Forbidden selectors: the 13-card family (density-spec inventory) + the
// steer-chip in-stream chip. Match the selector token at a rule boundary
// so `.card` never matches `.card-diff-tree-row` or similar longer names.
const CARD_FAMILY = [
  '.card',
  '.tool-block',
  '.artifact-card',
  '.card-terminal',
  '.card-diff',
  '.card-code-dispatch',
  '.card-web-search',
  '.card-skill',
  '.card-workflow',
  '.visibility-card',
  '.todo-card',
  '.recall-card',
  '.compact-card',
  '.steer-chip',
]

const EXEMPT = new Set([
  '.empty-welcome',
  '.empty-launcher',
  '.context-page-empty',
  '.context-page-empty-title',
  '.context-page-empty-sub',
  '.msg.user',
])

// Parse each top-level rule (selectorList { body }). Nested at-rules
// (@media, @supports) get their inner rules parsed the same way — we
// walk brace by brace and only surface leaf rules (bodies without `{`).
function iterRules(source) {
  const rules = []
  let i = 0
  const n = source.length
  while (i < n) {
    // Skip whitespace and comments
    while (i < n) {
      if (source[i] === '/' && source[i + 1] === '*') {
        const end = source.indexOf('*/', i + 2)
        i = end === -1 ? n : end + 2
      } else if (/\s/.test(source[i])) {
        i++
      } else break
    }
    if (i >= n) break
    // Read up to '{' or ';'
    let start = i
    let depth = 0
    while (i < n && source[i] !== '{' && source[i] !== ';') i++
    if (i >= n) break
    if (source[i] === ';') { i++; continue }
    const selector = source.slice(start, i).trim()
    i++ // consume {
    // Read matching body
    const bodyStart = i
    depth = 1
    while (i < n && depth > 0) {
      if (source[i] === '{') depth++
      else if (source[i] === '}') depth--
      if (depth > 0) i++
    }
    const body = source.slice(bodyStart, i)
    i++ // consume }
    // If selector starts with @, recurse into body (media/supports/etc.)
    if (selector.startsWith('@')) {
      for (const r of iterRules(body)) rules.push(r)
    } else {
      rules.push({ selector, body })
    }
  }
  return rules
}

function selectorTouchesFamily(selector) {
  // A rule's selectorList is comma-separated; if ANY selector in the list
  // ends in a token from the family (i.e., the LAST simple selector on
  // the compound is a family member), the rule sets that family's box.
  const groups = selector.split(',').map((s) => s.trim())
  const matched = []
  for (const g of groups) {
    // Last simple selector = trailing chunk before any pseudo (:hover etc.)
    // We match "the compound ends in .foo(.bar)*" by checking the whole
    // string ends with one of the family names, allowing further class
    // qualifiers (e.g. `.card.trigger-card`) but NOT a descendant chain
    // (e.g. `.card .steer-title` — that styles a child, not the card box).
    const bareTail = g.replace(/::?[a-z-]+(\([^)]*\))?$/i, '') // drop pseudo
    // Reject exemptions first — a selector whose last simple selector is an
    // exempt name is off-limits for the ban even if the compound also has
    // a family class (e.g. `.card.empty-welcome-frame`).
    for (const ex of EXEMPT) {
      if (endsWithSelector(bareTail, ex)) return null
    }
    for (const fam of CARD_FAMILY) {
      if (endsWithSelector(bareTail, fam)) {
        matched.push({ group: g, family: fam })
        break
      }
    }
  }
  return matched.length ? matched : null
}

// A compound `X.Y.Z` "ends with" `.Y` if `.Y` appears as one of the
// classes in the trailing compound (after the last combinator).
function endsWithSelector(compoundish, needle) {
  // Last simple selector = substring after the last combinator (space, >, +, ~)
  const lastSep = Math.max(
    compoundish.lastIndexOf(' '),
    compoundish.lastIndexOf('>'),
    compoundish.lastIndexOf('+'),
    compoundish.lastIndexOf('~'),
  )
  const tail = lastSep >= 0 ? compoundish.slice(lastSep + 1) : compoundish
  // Split the tail on `.` (except the very first char which may be `.`
  // itself). Tokens are the classes; needle without leading `.` is the
  // class name we're looking for.
  const need = needle.startsWith('.') ? needle.slice(1) : needle
  // Include ANY class in the compound tail (e.g., `.card.trigger-card` matches
  // both `.card` and `.trigger-card`).
  const classes = tail.split('.').filter(Boolean)
  return classes.includes(need)
}

const rules = iterRules(css)

test('centered-card ban — no `margin: * auto` on card family or steer-chip', () => {
  const offenders = []
  for (const { selector, body } of rules) {
    const hit = selectorTouchesFamily(selector)
    if (!hit) continue
    // Match `margin: <anything with the token `auto` as a whole word> ;`
    // Handles: `margin: auto`, `margin: 0 auto`, `margin: 6px auto`,
    //          `margin: var(--space-3) auto`, `margin: 12px auto 8px`.
    // NOT matched: `margin-left: auto` (right-anchoring, legitimate),
    //              `margin-top: auto` (flex spacer, legitimate),
    //              `overflow: auto` (different property).
    if (/(^|[\s;])margin\s*:[^;]*\bauto\b/i.test(body)) {
      offenders.push(`${selector.replace(/\s+/g, ' ')} — body has \`margin: … auto\``)
    }
  }
  assert.deepStrictEqual(offenders, [],
    `centered-card ban violated (margin auto):\n  ${offenders.join('\n  ')}`)
})

test('centered-card ban — no `align-self: center` on card family or steer-chip', () => {
  const offenders = []
  for (const { selector, body } of rules) {
    const hit = selectorTouchesFamily(selector)
    if (!hit) continue
    if (/(^|[\s;])align-self\s*:\s*center\b/i.test(body)) {
      offenders.push(`${selector.replace(/\s+/g, ' ')} — body has \`align-self: center\``)
    }
  }
  assert.deepStrictEqual(offenders, [],
    `centered-card ban violated (align-self center):\n  ${offenders.join('\n  ')}`)
})

test('selector matcher: family-detection sanity (guards the guard)', () => {
  // Positive cases — must be flagged as family.
  assert.ok(selectorTouchesFamily('.card'), '.card')
  assert.ok(selectorTouchesFamily('.card.steer'), '.card.steer')
  assert.ok(selectorTouchesFamily('.card.trigger-card'), '.card.trigger-card')
  assert.ok(selectorTouchesFamily('.tool-block'), '.tool-block')
  assert.ok(selectorTouchesFamily('.steer-chip'), '.steer-chip')
  // Compound classes get matched.
  assert.ok(selectorTouchesFamily('.tool-block.family-code'), '.tool-block.family-code')

  // Negative cases — descendant styles are NOT the card box.
  assert.strictEqual(selectorTouchesFamily('.card .steer-title'), null,
    'descendant of .card is not the card box')
  assert.strictEqual(selectorTouchesFamily('.tool-block summary'), null,
    'element inside .tool-block is not the block box')
  // Longer names starting with the same chars are NOT the family.
  assert.strictEqual(selectorTouchesFamily('.card-diff-tree-row'), null,
    'longer name is not `.card`')
  // Exemptions win over the family flag.
  assert.strictEqual(selectorTouchesFamily('.msg.user'), null,
    '.msg.user is exempt')
  assert.strictEqual(selectorTouchesFamily('.empty-welcome'), null,
    '.empty-welcome is exempt')
})

// Brace-balance machine lock. Third-time occurrence pattern — union-splicing
// style.css after a merge has three times swallowed later rules by leaving a
// block unclosed (Bench collapse f1efa1c was the most recent). Manual review
// missed it every time; add the machine so the eye never has to be right.
//
// Method: comment-aware char walk (strip `/* … */` first) that increments on
// `{`, decrements on `}`, and asserts (a) final depth === 0 (every open block
// is closed) and (b) depth never goes negative (no stray `}` before its `{`).
// Braces inside strings/URLs are theoretically possible; in practice CSS uses
// no string literals with `{`/`}` and url() bodies never contain them, so the
// raw walk after comment stripping is sound.
test('brace balance — style.css blocks close cleanly (union-splice lock)', () => {
  const src = css
  let depth = 0
  let minDepth = 0
  let firstNegativeAt = -1
  let i = 0
  const n = src.length
  while (i < n) {
    // Skip block comments so `/* } */` doesn't fool the counter.
    if (src[i] === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      i = end === -1 ? n : end + 2
      continue
    }
    const ch = src[i]
    if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
      if (depth < minDepth) {
        minDepth = depth
        if (firstNegativeAt === -1 && depth < 0) firstNegativeAt = i
      }
    }
    i++
  }
  // Turn a raw char index into a "line X" hint (best-effort; only used in
  // the failure message, so an off-by-one on the line is not load-bearing).
  const lineOf = (idx) => idx < 0 ? '?' : (src.slice(0, idx).match(/\n/g) || []).length + 1
  assert.strictEqual(minDepth, 0,
    `stray closing brace before its matching open at ~line ${lineOf(firstNegativeAt)} ` +
    `(minDepth=${minDepth}) — union-splice likely dropped a rule head`)
  assert.strictEqual(depth, 0,
    `style.css ends with ${depth} unclosed block${depth === 1 ? '' : 's'} — ` +
    `a rule head opened without its `+`}`+` and swallowed everything below. ` +
    `See f1efa1c (Bench collapse) for the last occurrence.`)
})

// -----------------------------------------------------------------------
// payload-controls overlap lock (2026-07-18 P0 hotfix, da779ac / merge
// 9743db1). The button cluster (pretty ⇅ raw · copy · download) used to
// sit on tool-block args/result rows via `float: right` + a negative
// `margin-top: -18px` pull-up hack; when the label text or drawer meta
// string got long (e.g. drawer's "(content · meta · isError · error ·
// durationMs)"), the buttons landed on top of the label text. The fix
// wrapped label+controls in a flex row (`.tool-block-label-row`) and
// switched the drawer callsite to a right-aligned strip
// (`.tool-json-section-controls`) — see style.css §payload-controls +
// §tool-block-label-row + §tool-json-section-controls.
//
// This gate freezes the fix so it can't silently regress: any rule
// whose selector ends in `.payload-controls`, `.tool-block-label-row`,
// or `.tool-json-section-controls` (in any state — plain, hover,
// descendant of a family class, etc.) is forbidden from re-introducing
// `float: right|left` or a negative `margin-top`. The trace-detail-pane
// mount (mount D, `.trace-detail-json-panel`) also gets covered by the
// same body-scan below since payload-controls is where the buttons
// live regardless of host.
//
// Method: match rules whose LAST simple selector is in the payload
// vocabulary (using the same endsWithSelector matcher we already trust
// for the centered-card gate) and grep the body for float/negative
// margin-top. `margin-left: auto` on `.payload-controls` is EXPLICITLY
// allowed — that's how the cluster right-anchors inside its flex host.
const PAYLOAD_VOCAB = [
  '.payload-controls',
  '.tool-block-label-row',
  '.tool-json-section-controls',
]

function selectorTouchesPayload(selector) {
  const groups = selector.split(',').map((s) => s.trim())
  const matched = []
  for (const g of groups) {
    const bareTail = g.replace(/::?[a-z-]+(\([^)]*\))?$/i, '')
    // Last simple selector = substring after the last combinator
    const lastSep = Math.max(
      bareTail.lastIndexOf(' '),
      bareTail.lastIndexOf('>'),
      bareTail.lastIndexOf('+'),
      bareTail.lastIndexOf('~'),
    )
    const tail = lastSep >= 0 ? bareTail.slice(lastSep + 1) : bareTail
    const classes = tail.split('.').filter(Boolean)
    for (const v of PAYLOAD_VOCAB) {
      if (classes.includes(v.slice(1))) { matched.push({ group: g, vocab: v }); break }
    }
  }
  return matched.length ? matched : null
}

test('payload-controls overlap lock — no `float: left|right` on payload vocabulary', () => {
  const offenders = []
  for (const { selector, body } of rules) {
    if (!selectorTouchesPayload(selector)) continue
    // `float: none` is a legitimate DE-fluke (drawer strip explicitly
    // sets `float: none` to nuke a legacy inherited float). We only ban
    // the two directional values that make things overlap.
    if (/(^|[\s;])float\s*:\s*(right|left)\b/i.test(body)) {
      offenders.push(`${selector.replace(/\s+/g, ' ')} — body has \`float: right|left\``)
    }
  }
  assert.deepStrictEqual(offenders, [],
    `payload-controls overlap lock violated (float:right|left reintroduced):\n  ${offenders.join('\n  ')}\n` +
    'Root cause of the 2026-07-18 P0: float:right + margin-top:-18px pulled the button ' +
    'cluster on top of the label text when the drawer meta string ran long. Use the ' +
    'flex-row shape (`.tool-block-label-row` for inline / `.tool-json-section-controls` ' +
    'for the drawer) instead — see style.css around the payload-controls block.')
})

test('payload-controls overlap lock — no negative `margin-top` on payload vocabulary', () => {
  const offenders = []
  for (const { selector, body } of rules) {
    if (!selectorTouchesPayload(selector)) continue
    // Match `margin-top: -Npx` (or `-N`, or `-N.Nrem`, etc.). The
    // shorthand `margin: -Npx …` on a payload rule is equally bad; catch
    // both. We DO allow `margin: 0`, `margin-top: 0`, and any positive
    // value; we DO allow `margin-left: auto` (that's the right-anchor).
    if (/(^|[\s;])margin-top\s*:\s*-\d/i.test(body) ||
        /(^|[\s;])margin\s*:\s*-\d/i.test(body)) {
      offenders.push(`${selector.replace(/\s+/g, ' ')} — body has negative margin-top`)
    }
  }
  assert.deepStrictEqual(offenders, [],
    `payload-controls overlap lock violated (negative margin-top reintroduced):\n  ${offenders.join('\n  ')}\n` +
    'The negative-margin pull-up hack was half of the overlap bug (the other half was ' +
    '`float: right`). Both are banned on `.payload-controls`, `.tool-block-label-row`, ' +
    'and `.tool-json-section-controls` — the merged fix (da779ac) uses `margin-left: auto` ' +
    'inside a flex row instead. See style.css around the payload-controls block.')
})

test('payload-controls overlap lock — the fix\'s flex row shape stays present', () => {
  // Positive assertion: the two flex hosts that carry the fix must still
  // exist as rules and still declare `display: flex`. A refactor that
  // deletes them (thinking they\'re dead) would silently reintroduce
  // the overlap.
  function findRule(cls) {
    for (const { selector, body } of rules) {
      const groups = selector.split(',').map((s) => s.trim())
      for (const g of groups) {
        // Match `<cls>` as the whole selector, or `<cls>` followed by
        // a `>` child combinator (both `.foo` and `.foo > .bar` count
        // as "the rule that sets .foo").
        if (g === cls || g.startsWith(cls + ' ') || g.startsWith(cls + '>') || g.startsWith(cls + '.')) {
          return { selector, body }
        }
      }
    }
    return null
  }
  const row = findRule('.tool-block-label-row')
  assert.ok(row, '.tool-block-label-row rule missing — the P0 flex fix has been deleted')
  assert.match(row.body, /display\s*:\s*flex/i,
    '.tool-block-label-row must stay `display: flex` — that is what pushes the button cluster to the right instead of stacking it via float.')

  const strip = findRule('.tool-json-section-controls')
  assert.ok(strip, '.tool-json-section-controls rule missing — the drawer overlap fix has been deleted')
  assert.match(strip.body, /display\s*:\s*flex/i,
    '.tool-json-section-controls must stay `display: flex` — the drawer callsite relies on it to right-align the controls strip.')
})
