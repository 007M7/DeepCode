// task #164: guard against .stream flex-column collapsing non-scrolling
// children (approval / exit_plan_mode / steer cards) to ~16px. The fix in
// style.css relies on two rules:
//   1. `.stream { min-height: 0; ... }`  — lets stream itself scroll instead
//      of overflowing its column-flex parent (.pane / .main).
//   2. `.stream > * { flex-shrink: 0; }` — each direct child renders at its
//      intrinsic height so interaction cards with fixed textarea+buttons do
//      not get squashed when the total body is taller than the viewport.
// Both regressed silently before because CSS isn't in the unit test loop; this
// file adds a source-string assertion so the ratchet catches removals.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CSS = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'style.css'),
  'utf8',
);

test('#164: .stream declares min-height:0 so it can scroll inside column-flex parent', () => {
  // find the first `.stream {` block (line 289 region) — the layout rule, not
  // the theme rebase rule further down that only tweaks padding.
  const idx = CSS.indexOf('.stream {');
  assert.ok(idx >= 0, '.stream rule must exist');
  const block = CSS.slice(idx, CSS.indexOf('}', idx) + 1);
  assert.match(
    block,
    /min-height:\s*0\b/,
    '.stream must set min-height:0 to allow internal scroll under flex parent',
  );
  assert.match(
    block,
    /flex-direction:\s*column/,
    'sanity: the guarded block is still the column-flex stream rule',
  );
  assert.match(
    block,
    /overflow-y:\s*auto/,
    'sanity: stream is still the scroll container',
  );
});

test('#164: .stream > * has flex-shrink:0 so intrinsic-height children do not collapse', () => {
  // The rule appears on its own line as `.stream > * { flex-shrink: 0; ... }`.
  // Assert directly on that shape so a rewrite that reorders declarations
  // still passes as long as the intent stays.
  const re = /^\.stream\s*>\s*\*\s*\{[^}]*flex-shrink:\s*0/m;
  assert.match(
    CSS,
    re,
    '.stream > * must set flex-shrink:0 to keep interaction cards / rows from collapsing',
  );
});

test('#164: guarded rules are documented in-place so future edits know why', () => {
  // Both rules should carry a "#164" reference in a nearby comment so a
  // subsequent editor sees the bug id before deleting them. The comment
  // preceding `.stream > *` is the primary docstring for the fix.
  const bookmark = CSS.match(/task #164:[\s\S]{0,600}\.stream > \*/);
  assert.ok(
    bookmark,
    'a task #164 comment must sit adjacent to the .stream > * rule so the intent survives future refactors',
  );
});
