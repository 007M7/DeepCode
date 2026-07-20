// Static analysis: guard against the historical "top-level `const api =`
// collision" regression. Every renderer script under src/renderer/*.js loads
// as a classic <script> tag into one shared global scope. A top-level
// `const NAME = ...` in two of them is a hard SyntaxError at load and the
// second script (and everything after) dies silently — that was the
// six-module `const api = { ... }` bug the IIFE fence fixed.
//
// This test runs `node --test`, so the guard fires as part of the same
// suite the rest of the shell already relies on. Cheaper and more reliable
// than a git pre-push hook because a developer never has to opt in.
//
// Rules enforced here:
//   1. All renderer scripts EXCEPT the ones listed in `NON_IIFE_ALLOWLIST`
//      must be wrapped in an IIFE (`;(function () { ... })()`). New scripts
//      that forget the wrapper trip this immediately.
//   2. Across the allow-listed non-IIFE files, no two top-level `const` /
//      `let` / `var` / `function` identifiers may collide.
//   3. No allow-listed non-IIFE file may declare a top-level `const api`.
//      That specific name is the historical repro — future files should
//      pick a namespaced identifier or stay IIFE-wrapped.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const RENDERER_DIR = path.join(__dirname, '..', 'src', 'renderer')

// Renderer files that legitimately skip the IIFE fence:
//   - renderer.js — the shell entrypoint. Owns `state`, `streamEl`, `bootUi`,
//     `onSessionEvent`; every other renderer file reads those globals by name.
//   - Dual-export pure modules — files that both `module.exports` (for
//     `node --test`) and assign to `window.__dshXxx` (for the renderer).
//     Wrapping them in an IIFE breaks the CommonJS require path. Their public
//     surface is namespaced under `window.__dshXxx`; only `function` names
//     leak into the global scope, and the collision check below still catches
//     any accidental duplicate across the allow-list.
const NON_IIFE_ALLOWLIST = new Set([
  'renderer.js',
  'context-meter.js',
  'compact-badge.js',
  // demo 批 2 (§1.7 tabs + §1.2 rail): dual-exported pure modules,
  // same pattern as compact-badge.js.
  'compact-card.js',
  'context-rail.js',
  // demo 批 3 (§1.4 subagent + §1.6 workflow 五族): dual-exported pure
  // modules plus inlined fixture data (debug-fixtures.js).
  'workflow-view.js',
  'subagent-view.js',
  'debug-fixtures.js',
  'event-filter.js',
  'panels-c.js',
  'tool-cards.js',
  'widgets.js',
  'capabilities.js',
  // Growth v2 (Ticket #140) pure model: dual-exported via module.exports +
  // window.__dshGrowthV2Model. Follows the compact-badge.js pattern.
  'growth-v2-model.js',
  // §1.1 + §1.3 pure modules (task #136): same dual-export shape as
  // compact-badge — CommonJS for node --test, `window.__dsh*` for the
  // renderer. Not IIFE'd so preloadPure can require() them.
  'inject-family.js',
  'trace-aggregator.js',
  // Task #158 cost-chip data source: dual-exported const table +
  // side-effect assignment to window.__dshPriceTable. Same pattern as
  // debug-fixtures.js — no functions to isolate, just static data.
  'price-table.js',
  // Task #162 rec 22 pure parser: dual-exported (module.exports for
  // node --test, window.__dshParseJson for renderer). Same shape as
  // event-filter.js / inject-family.js. No functions collide with
  // other top-level identifiers.
  'parse-incremental-json.js',
  // Task #162 rec 21 reasoning block: dual-exported pure module +
  // DOM builder. Follows the same pattern as inject-family.js.
  'reasoning-block.js',
  // Task #162 rec 23 turn footer: dual-exported pure module + DOM
  // builder. Same shape as reasoning-block.js.
  'turn-footer.js',
  // Task #162 rec 22-bis assistant-turn container: dual-exported
  // (module.exports for node --test, window.__dshAssistantTurn for
  // renderer). Exposes a TurnBuilder class that assembles reasoning /
  // text / tool-row / result / footer children in wire order.
  'assistant-turn.js',
  // Task #96 F-05: Debug popover mock helpers extracted from renderer.js.
  // Non-IIFE by design so the top-level `function mock*` declarations land
  // on the same global scope renderer.js's click-listener bindings resolve
  // against (`addEventListener('click', mockApproval)` at renderer.js
  // top-level). No exports; loads BEFORE renderer.js in index.html.
  'mock-fixtures.js',
  // Task #188 rubrics + #191 annotation pure models + inlined fixture
  // seeds: dual-exported (module.exports for node --test, window.__dsh*
  // for renderer). Same shape as compact-badge.js / debug-fixtures.js.
  'rubrics-model.js',
  'annotation-model.js',
  'rubrics-seed.js',
  // Hub page (#186 + #190) pure model: dual-exported (module.exports for
  // node --test, globalThis.HubModel for the renderer). Follows the
  // compact-badge.js / inject-family.js pattern — top-level KIND_ORDER,
  // KIND_META, and helper functions are meant to be one shared shape.
  'hub-model.js',
  // Task #201 turn-flow glyph (trace-viz §4d): dual-exported pure module
  // + SVG builder. Same shape as turn-footer.js — CommonJS require for
  // node --test, window.__dshTurnFlowGlyph for the renderer.
  'turn-flow-glyph.js',
  // Task #187 Bench page: pure data model + inlined fixture batch.
  // bench-model.js follows the growth-v2-model.js dual-export pattern
  // (module.exports for node --test, window.__dshBenchModel for the
  // renderer). bench-fixture.js follows the debug-fixtures.js pattern
  // (static inlined JSON attached to window.__dshBenchFixture).
  'bench-model.js',
  'bench-fixture.js',
  // Task #185 Context page pure projections: dual-exported
  // (module.exports for node --test, window.__dshContextPageModel for
  // renderer). Same shape as inject-family.js / context-rail.js. No
  // top-level function names collide with the shared renderer scope.
  'context-page-model.js',
  // Task #225 Tracing index (reference tracing UI-style project runs table): pure
  // per-session aggregator dual-exported (module.exports for node --test,
  // window.__dshTracingIndexModel for renderer). Reads through
  // trace-aggregator's usage/cost helpers so the numbers align with every
  // other cost surface. Same shape as bench-model.js / context-page-model.js.
  'tracing-index-model.js',
  // Ticket #15 (2026-07-17) upstream-align pure modules: dual-exported
  // (module.exports for node --test, window.__dsh* for renderer). Same
  // shape as inject-family.js / subagent-view.js.
  //   subagent-lineage.js  — live subagent event router (Part A)
  //   raw-inject.js        — envelope:'raw' classifier             (Part B)
  'subagent-lineage.js',
  'raw-inject.js',
  // fix/expand-affordance (2026-07-18) universal aria-expanded reflector:
  // dual-exported (module.exports for node --test, window.__dshDetailsAria
  // for renderer). Same shape as inject-family.js / raw-inject.js — just
  // one `wireDetailsAria(details, summary)` helper, no functions collide.
  'details-aria.js',
  // lane-ctx-deep (task #51, 2026-07-19) Context-page deepening. Four
  // dual-exported pure modules — same shape as inject-family.js /
  // context-page-model.js. CommonJS require for node --test,
  // `window.__dsh*` handle for the renderer. No top-level function names
  // collide with the shared renderer scope.
  'context-window-breakdown.js',
  'intervention-timeline.js',
  'compact-config-model.js',
  'subagent-drilldown.js',
  // lane-msg-queue (2026-07-20) composer message queue: dual-exported pure
  // FIFO model — module.exports for node --test, window.__dshMsgQueueModel
  // for the renderer. Same shape as compact-config-model.js; preloadPure
  // require()s it so it must not be IIFE-wrapped. Sole top-level binding is
  // `function createMsgQueue`, unique across the shared scope.
  'msg-queue-model.js',
])

function listRendererScripts() {
  return fs.readdirSync(RENDERER_DIR)
    .filter((f) => f.endsWith('.js'))
    .sort()
}

function isIifeWrapped(source) {
  // Walk lines top-down; skip blank / line-comment / 'use strict' / block-
  // comment lines and stop at the first substantive statement. That
  // statement must open the IIFE (`(function` or `;(function` or the
  // `void function` variant). This mirrors how Chromium's script host
  // parses the file — the check is intentionally forgiving about spacing
  // and the leading semicolon, but strict about "the whole file body
  // lives inside one call expression".
  const lines = source.split('\n')
  let inBlockComment = false
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    if (inBlockComment) {
      if (line.includes('*/')) inBlockComment = false
      continue
    }
    if (line.startsWith('/*')) {
      if (!line.includes('*/')) inBlockComment = true
      continue
    }
    if (line.startsWith('//')) continue
    if (/^['"]use strict['"];?$/.test(line)) continue
    return /^;?\s*\(?\s*(?:void\s+)?function\s*\(/.test(line) ||
      /^;?\s*\(\s*(?:async\s+)?function\s*\(/.test(line)
  }
  return false
}

// Grab every top-level `const|let NAME` declaration and every top-level
// `function NAME` in a source file. Only `const` and `let` collisions are
// FATAL at script-load time (they raise `SyntaxError: Identifier NAME has
// already been declared` and abort the second script, which is exactly what
// the six-module `const api` bug looked like). `function` declarations
// silently overwrite an earlier one, so their collision is a maintenance
// hazard rather than a load-time crash; the returned shape flags each type
// separately so the assertion can grade them differently.
//
// "Top-level" == column-0 declaration. This won't catch cursed cases like
// `\tconst api = ...` but every existing renderer file follows the
// convention, and the check is meant to catch human mistakes rather than
// arbitrary hostile input.
function topLevelBindings(source) {
  const fatal = []   // const / let — load-time crash on collision
  const soft = []    // function — silent overwrite on collision
  const lines = source.split('\n')
  for (const line of lines) {
    let m = line.match(/^(?:const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/)
    if (m) { fatal.push(m[1]); continue }
    m = line.match(/^var\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/)
    // `var` at top-level of a classic script attaches to the global object
    // and re-declaration is silently tolerated, so treat it like function.
    if (m) { soft.push(m[1]); continue }
    m = line.match(/^function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/)
    if (m) { soft.push(m[1]); continue }
    m = line.match(/^async\s+function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/)
    if (m) { soft.push(m[1]); continue }
  }
  return { fatal, soft }
}

test('every renderer script is IIFE-wrapped except the entrypoint', () => {
  const violations = []
  for (const file of listRendererScripts()) {
    if (NON_IIFE_ALLOWLIST.has(file)) continue
    const src = fs.readFileSync(path.join(RENDERER_DIR, file), 'utf8')
    if (!isIifeWrapped(src)) {
      violations.push(file)
    }
  }
  assert.deepEqual(violations, [],
    'These renderer scripts leak top-level bindings into the global scope. ' +
    'Wrap them in `;(function () { ... })()` or add to NON_IIFE_ALLOWLIST ' +
    'with a comment explaining why.')
})

test('no allow-listed non-IIFE renderer script declares a top-level `const api`', () => {
  // Historical repro: six renderer modules each ended with `const api = { ... }`
  // to publish their public surface. All six landed in one shared global,
  // and the second load was a hard SyntaxError. Even the intended entrypoint
  // (renderer.js) must never use this exact name — it's the tripwire.
  for (const file of NON_IIFE_ALLOWLIST) {
    const src = fs.readFileSync(path.join(RENDERER_DIR, file), 'utf8')
    const { fatal } = topLevelBindings(src)
    assert.ok(!fatal.includes('api'),
      `${file} declares top-level \`const api\` — that's the name that ` +
      `collided in the six-module regression. Rename it or hide behind an ` +
      `IIFE.`)
  }
})

test('no two allow-listed non-IIFE renderer scripts share a top-level const/let', () => {
  // Fatal-class check: `const` / `let` at column 0 of a classic script raises
  // `SyntaxError: Identifier NAME has already been declared` when the second
  // file loads, and every script tag after that never executes. This is the
  // load-time crash the IIFE fence exists to prevent. `function` overwrites
  // are silent and covered by the softer check below.
  //
  // The failure message names both culprits so the fix is obvious.
  const byName = new Map() // name -> [files]
  for (const file of NON_IIFE_ALLOWLIST) {
    const src = fs.readFileSync(path.join(RENDERER_DIR, file), 'utf8')
    const { fatal } = topLevelBindings(src)
    for (const name of fatal) {
      if (!byName.has(name)) byName.set(name, [])
      byName.get(name).push(file)
    }
  }
  const collisions = []
  for (const [name, files] of byName.entries()) {
    if (files.length > 1) collisions.push({ name, files })
  }
  assert.deepEqual(collisions, [],
    'Top-level `const`/`let` collision(s) between allow-listed renderer ' +
    'scripts. This is a load-time SyntaxError in the browser; the second ' +
    'script tag will silently die. Rename or IIFE-wrap the loser.')
})

test('duplicate top-level `function` names between renderer.js and pure modules are known-and-safe', () => {
  // The pure modules (event-filter.js, panels-c.js, tool-cards.js, widgets.js,
  // context-meter.js) publish their exports via `window.__dshFoo` for the
  // renderer AND `module.exports` for `node --test`. Their internal
  // `function foo()` names may repeat names inside renderer.js — that's a
  // silent overwrite at load, not a crash, and the shape of the pure-module
  // wrappers means each caller reads through `window.__dshEventFilter.foo`
  // rather than the bare global. This check ratchets the current known set
  // so a NEW soft collision has to be reviewed and either accepted (added
  // to the allow-list here) or fixed.
  const known = new Set([
    // event-filter.js's helpers were extracted from renderer.js; renderer.js
    // still holds the historical copies for the direct-call sites that
    // haven't been retargeted through `window.__dshEventFilter.*` yet. This
    // is deliberately dead code on the renderer.js side — kept only so the
    // extraction can happen without a lockstep multi-file diff.
    'describeSource:renderer.js:event-filter.js',
    'isDevOnlyEventType:renderer.js:event-filter.js',
    // textFromContentBlocks: same extraction pattern — renderer.js keeps the
    // callable copy (the switch-arm handlers call it directly), the pure
    // module hosts the tested implementation. The two must stay in sync;
    // event-filter.test.js has a source-level drift alarm on the renderer
    // copy that guards against the `[${b.type}]` fallback returning.
    'textFromContentBlocks:renderer.js:event-filter.js',
    // CTX-merge lesson (2026-07-17): turn-flow-glyph (#201) and context-page
    // (#185) each need to classify a compact event when projecting the trace
    // slice they own. Two independent private helpers land at the same name;
    // both keep their local copy because the shape check is intra-module
    // (glyph steps vs context ledger rows). No caller reaches the bare
    // `isCompactEvent` global — turn-flow-glyph attaches to
    // window.__dshTurnFlowGlyph, context-page-model attaches to
    // window.__dshContextPageModel. Silent overwrite is harmless here.
    'isCompactEvent:turn-flow-glyph.js:context-page-model.js',
  ])
  const byName = new Map()
  for (const file of NON_IIFE_ALLOWLIST) {
    const src = fs.readFileSync(path.join(RENDERER_DIR, file), 'utf8')
    const { soft } = topLevelBindings(src)
    for (const name of soft) {
      if (!byName.has(name)) byName.set(name, [])
      byName.get(name).push(file)
    }
  }
  const unexpected = []
  for (const [name, files] of byName.entries()) {
    if (files.length < 2) continue
    const key = [name, ...files].join(':')
    if (known.has(key)) continue
    unexpected.push({ name, files })
  }
  assert.deepEqual(unexpected, [],
    'New top-level `function` name collision between renderer files. This ' +
    'is a silent overwrite (not a crash), but the pattern was banned. ' +
    'Rename or add to the `known` set in this test with a comment.')
})
