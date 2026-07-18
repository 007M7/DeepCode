'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rewriteCommentText, rewriteFile } = require('../tools/comment-sweep-apply.js');

// -----------------------------------------------------------------------------
// rewriteCommentText — pure text-level transform tests. Each pair mirrors a
// real hit family from the scanner.
// -----------------------------------------------------------------------------

// Fresh-eyes P0 with review-fresh-eyes.md coordinate: full prefix strip.
test('strip: Fresh-eyes P0 dated + review file → keep constraint', () => {
  const src = 'Fresh-eyes P0 (2026-07-18, review-fresh-eyes.md #4 + team-lead follow-up): gate the Debug popover on DSH_QA=1.';
  const out = rewriteCommentText(src);
  assert.equal(out, 'gate the Debug popover on DSH_QA=1.');
});

// Bare Fresh-eyes P0:
test('strip: Fresh-eyes P0 bare → keep constraint', () => {
  const src = 'Fresh-eyes P0: user-driven pick deserves the toast.';
  const out = rewriteCommentText(src);
  assert.equal(out, 'user-driven pick deserves the toast.');
});

// Ticket #NNN with parenthetical
test('strip: Ticket #168 step 1: → keep body', () => {
  const src = 'Ticket #168 step 1: per-block payload controls (pretty⇅raw, copy,)';
  const out = rewriteCommentText(src);
  assert.equal(out, 'per-block payload controls (pretty⇅raw, copy,)');
});

test('strip: Ticket A (parenthetical): → keep body', () => {
  const src = 'Ticket A (2026-07-16): two-way branch handling.';
  const out = rewriteCommentText(src);
  assert.equal(out, 'two-way branch handling.');
});

// task #NNN + rec 22-bis + phase 2 (pi §2.3)
test('strip: task #162 rec 22-bis phase 2 (pi §2.3): → keep body', () => {
  const src = 'task #162 rec 22-bis phase 2 (pi §2.3): when an assistant bubble lands.';
  const out = rewriteCommentText(src);
  assert.equal(out, 'when an assistant bubble lands.');
});

// F-N (e2e audit) prefix
test('strip: F-3 (2026-07-18 e2e audit): → keep body', () => {
  const src = 'F-3 (2026-07-18 e2e audit): last trace card that finishTraceStep saw.';
  const out = rewriteCommentText(src);
  assert.equal(out, 'last trace card that finishTraceStep saw.');
});

// team-lead §X.Y prefix
test('strip: team-lead §4.1 fix → keep body', () => {
  const src = 'team-lead §4.1 fix: real-daemon truth wins over cached title.';
  const out = rewriteCommentText(src);
  assert.equal(out, 'real-daemon truth wins over cached title.');
});

// Round-visual N1 prefix
test('strip: Round-visual N1 (2026-07-16): → keep body', () => {
  const src = 'Round-visual N1 (2026-07-16): the round-1 pass exempted rank-0.';
  const out = rewriteCommentText(src);
  // The trailing "round-1" is an inline round tag; should be stripped too.
  assert.match(out, /^the .*exempted rank-0\.$/);
  assert.ok(!/Round-visual/i.test(out));
});

// Trailing paren: (review-fresh-eyes.md #N)
test('strip: (review-fresh-eyes.md #2) trailing → gone', () => {
  const src = 'The layout toast only fires on user-driven picks (review-fresh-eyes.md #2).';
  const out = rewriteCommentText(src);
  assert.equal(out, 'The layout toast only fires on user-driven picks.');
});

// Trailing paren: (QA round-3 shot 07)
test('strip: (QA round-3 shot 07) trailing → gone', () => {
  const src = 'On stdio profiles there is a delay before the runtime chip flips (QA round-3 shot 07).';
  const out = rewriteCommentText(src);
  assert.equal(out, 'On stdio profiles there is a delay before the runtime chip flips.');
});

// Upstream packages/*/src/*.ts:33-52 inline coord → stripped
test('strip: packages/*/src/*.ts:33-52 inline → gone', () => {
  const src = 'wire packages/ui/jsonrpc/src/server.ts:89-96 carries only parent/child.';
  const out = rewriteCommentText(src);
  assert.equal(out, 'wire carries only parent/child.');
});

// pi-agent-ui-study.md §2.3 → stripped
test('strip: pi-agent-ui-study.md §2.3 → gone (artifact ref removed)', () => {
  const src = 'The active turn shape (rec 22-bis, pi-agent-ui-study.md §2.3): one section per turn.';
  const out = rewriteCommentText(src);
  // The pi-agent-ui-study reference is gone; the constraint is preserved.
  assert.ok(!/pi-agent-ui-study/.test(out), `got: ${out}`);
  assert.ok(/one section per turn/.test(out));
});

// density-spec §X — team-lead 2026-07-18: STRIP (docs/design-refs/ is dropped
// from the OSS artefact, so references would 404 in the published tree).
test('strip: density-spec §2 → gone, constraint kept', () => {
  const src = 'L0 row grammar (density-spec §2 · t159): glyph column · type · gist.';
  const out = rewriteCommentText(src);
  assert.ok(!/density-spec/.test(out), `got: ${out}`);
  assert.ok(/glyph column · type · gist/.test(out));
});

// style-guide reference — same treatment as density-spec.
test('strip: style-guide reference → gone', () => {
  const src = 'Per style-guide §4 the row must be full-width.';
  const out = rewriteCommentText(src);
  assert.ok(!/style-guide/.test(out), `got: ${out}`);
  assert.ok(/full-width/.test(out));
});

// reference tracing UI study §6 rec 4 → stripped
test('strip: LangSmith study §6 rec 4 → gone (internal artifact)', () => {
  const src = 'Follow LangSmith study §6 rec 4 streaming-first: drop a placeholder card.';
  const out = rewriteCommentText(src);
  assert.equal(out, 'Follow streaming-first: drop a placeholder card.');
});

// Whole-line stripping: line whose sole body IS a hit
test('empty-out: comment that is 100% prefix returns empty', () => {
  const src = 'Fresh-eyes P0 (2026-07-18, review-fresh-eyes.md #4):';
  const out = rewriteCommentText(src);
  assert.equal(out, '');
});

// No hit → identity transform
test('identity: comment with no artifact reference is untouched', () => {
  const src = 'Compact "3s / 12m / 4h / 2d" formatter used by the sidebar.';
  const out = rewriteCommentText(src);
  assert.equal(out, src);
});

// bare #NNN mid-sentence — we do NOT strip these (see rules.md: bare hash
// numbers preserving the reference to a specific PR/ticket is often the
// only anchor the reader has; scanner reports but reviewer decides).
test('keep: bare #218 mid-sentence anchor is preserved by default', () => {
  const src = 'pre-#218 daemons; fall through and try the fetch.';
  const out = rewriteCommentText(src);
  assert.equal(out, src);
});

// Nested "old ledger" hash — same rule.
test('keep: /#154 old ledger/ mid-sentence anchor', () => {
  const src = 'zero-render turn from the #154 old ledger scenario.';
  const out = rewriteCommentText(src);
  assert.equal(out, src);
});

// -----------------------------------------------------------------------------
// rewriteFile — end-to-end on tiny synthetic files. Ensures code lines are
// never touched.
// -----------------------------------------------------------------------------

test('e2e: strip leading artifact prefix, keep code intact', () => {
  const src = [
    "'use strict'",
    '',
    '// Fresh-eyes P0 (2026-07-18, review-fresh-eyes.md #4):',
    '// gate the Debug popover on DSH_QA=1.',
    'if (document.body.dataset.qa) {',
    '  render()',
    '}',
    '',
  ].join('\n');
  const { src: out, stripped } = rewriteFile(src);
  // Every code line must be present verbatim.
  assert.ok(out.includes("'use strict'"));
  assert.ok(out.includes('if (document.body.dataset.qa) {'));
  assert.ok(out.includes('  render()'));
  // Fresh-eyes prefix must be gone.
  assert.ok(!/Fresh-eyes P0/.test(out));
  // The constraint sentence stays.
  assert.ok(/gate the Debug popover on DSH_QA=1\./.test(out));
  assert.ok(stripped.lines >= 1); // one prefix-only line was removed
});

test('e2e: block comment with mixed body loses artifact lines, keeps rest', () => {
  const src = [
    '/*',
    ' * task #162 rec 22-bis: the active assistant-turn <section>. Populated',
    ' * by ensureTurnContainer on first assistant-side event of a turn, cleared',
    ' * by finishTurnContainer on turn/end.',
    ' */',
    'function ensureTurnContainer(){}',
    '',
  ].join('\n');
  const { src: out } = rewriteFile(src);
  assert.ok(!/task #162/.test(out));
  assert.ok(!/rec 22-bis/.test(out));
  assert.ok(/active assistant-turn/.test(out));
  assert.ok(/ensureTurnContainer/.test(out));
});

test('e2e: pure artifact banner block becomes gone', () => {
  const src = [
    'const before = 1',
    '// task #201 / trace-viz §4d: inline "shape of this turn" glyph. Drawn',
    'const after = 2',
  ].join('\n');
  const { src: out } = rewriteFile(src);
  // Only the artifact prefix strips; the constraint sentence stays with //
  assert.ok(/const before = 1/.test(out));
  assert.ok(/const after = 2/.test(out));
  assert.ok(/inline "shape of this turn" glyph\. Drawn/.test(out));
  assert.ok(!/task #201/.test(out));
  assert.ok(!/trace-viz §4d/.test(out));
});

test('e2e: no strings in code are ever modified', () => {
  const src = [
    'const s1 = "task #999: still here"',
    "const s2 = 'Fresh-eyes P0 (whatever): also still here'",
    'const s3 = `Ticket #123 keep me`',
    '// task #999: strip me',
    'const after = 1',
  ].join('\n');
  const { src: out } = rewriteFile(src);
  assert.ok(out.includes('"task #999: still here"'));
  assert.ok(out.includes("'Fresh-eyes P0 (whatever): also still here'"));
  assert.ok(out.includes('`Ticket #123 keep me`'));
  assert.ok(!out.includes('// task #999: strip me'));
});

test('e2e: identity on file without any hits', () => {
  const src = [
    "'use strict'",
    '',
    '// Compact formatter used by the sidebar.',
    'function fmt(n) { return String(n) }',
    '',
  ].join('\n');
  const { src: out } = rewriteFile(src);
  assert.equal(out, src);
});

// Inline `(task #N …)` parens carrying trailing tokens/dates. Widened
// paren-ticket-num rule (2026-07-18): the old rule only matched `(task #N)`
// verbatim; we now accept `(task #N P0-4, 2026-07-16)` / `(task #N layer 1)`
// / `(2026-07-17, task #49)` shapes discovered in src/main dry-run.
test('strip: inline (task #N trailing tokens) → gone, sentence intact', () => {
  const src = 'Two-way branch (task #103 P0-4, 2026-07-16). A real SessionForkError from the wire.';
  const out = rewriteCommentText(src);
  assert.ok(!/task #103/.test(out), `got: ${out}`);
  assert.ok(/Two-way branch/.test(out));
  assert.ok(/SessionForkError/.test(out));
});

test('strip: inline (task #N layer 1) → gone', () => {
  const src = 'Static validation (task #37 layer 1). Same three questions the Plugins page asks.';
  const out = rewriteCommentText(src);
  assert.ok(!/task #37/.test(out), `got: ${out}`);
  assert.ok(/Static validation/.test(out));
  assert.ok(/Same three questions/.test(out));
});

test('strip: leading-date-then-task paren → gone', () => {
  const src = 'MCP note (2026-07-17, task #49): the MCP-server config card writes a shallow-JSON block.';
  const out = rewriteCommentText(src);
  assert.ok(!/task #49/.test(out), `got: ${out}`);
  assert.ok(!/2026-07-17/.test(out), `got: ${out}`);
  assert.ok(/MCP note/.test(out));
  assert.ok(/config card writes/.test(out));
});

// Pre-existing empty parens (function-call references inside comments) must
// survive the cleanup step even when other strips fire in the same comment.
// Regression guard added 2026-07-18 after src/main/main.js dry-run mangled
// `daemon.ensureUp()` → `daemon.ensureUp` alongside a legit strip.
test('preserve: function-call refs like foo() are not touched', () => {
  const src = 'startRuntime is still in daemon.ensureUp() or _spawnOnce()';
  const out = rewriteCommentText(src);
  assert.equal(out, src);
});

test('preserve: function-call ref + inline task-num strip in same comment', () => {
  const src = 'Two-way branch (task #103 P0-4, 2026-07-16) fires when ensureUp() lands.';
  const out = rewriteCommentText(src);
  assert.ok(!/task #103/.test(out), `got: ${out}`);
  assert.ok(/ensureUp\(\)/.test(out), `got: ${out}`);
});

test('preserve: negation code-shape !foo() stays intact', () => {
  const src = 'Guard rejects if !shellHomeExists() || !readShellConfig() at boot.';
  const out = rewriteCommentText(src);
  assert.equal(out, src);
});

// Compound "QA round-N shot NN" is a single atomic artifact tag; do not
// strip only `round-N` leaving `QA shot NN` orphan text.
test('strip: QA round-N shot NN → whole tag gone', () => {
  const src = 'See profile map — QA round-3 shot 07 caught the daemon-echo hardcode.';
  const out = rewriteCommentText(src);
  assert.ok(!/round-3/.test(out), `got: ${out}`);
  assert.ok(!/shot 07/.test(out), `got: ${out}`);
  assert.ok(/See profile map/.test(out));
  assert.ok(/caught the daemon-echo hardcode/.test(out));
});

// Orphan `):` line body after upstream-path strip: whole line drops.
test('strip: orphan close-paren line body → gone', () => {
  const src = [
    '/**',
    ' * Doc paragraph one.',
    ' * packages/ui/jsonrpc/src/interactions.ts:295-296',
    ' * ):',
    ' * Doc paragraph two.',
    ' */',
    'function f(){}',
  ].join('\n');
  const { src: out } = rewriteFile(src);
  assert.ok(!/interactions\.ts/.test(out), `got:\n${out}`);
  assert.ok(!/\)\s*:/.test(out) || !/^\s*\*\s*\)\s*:\s*$/m.test(out), `got:\n${out}`);
  assert.ok(/Doc paragraph one/.test(out));
  assert.ok(/Doc paragraph two/.test(out));
});

// Regex literals containing quote chars must NOT trap the walker in "string
// state". Regression: `/model\s+"([^"]+)"/i` at renderer.js:1110 left the
// walker inside a phantom string until EOF, blocking every downstream comment
// from being scanned. Regex-start detection uses JS's actual ASI-style rule.
test('walker: regex literal with double quotes does not trap string state', () => {
  const src = [
    'const rx = /model\\s+"([^"]+)"/i',
    '// task #999: strip me',
    'const x = 1;',
  ].join('\n');
  const { src: out } = rewriteFile(src);
  assert.ok(!/task #999/.test(out), `got:\n${out}`);
  assert.ok(/const x = 1;/.test(out));
});

test('walker: regex with single quotes does not trap', () => {
  const src = [
    "const rx2 = /'/;",
    '// task #999: strip me',
    'const x = 1;',
  ].join('\n');
  const { src: out } = rewriteFile(src);
  assert.ok(!/task #999/.test(out), `got:\n${out}`);
});

test('walker: division operator is NOT treated as regex start', () => {
  const src = [
    'const half = width / 2;',
    'const s = "task #999: keep me because I am in a string";',
    '// task #999: strip me',
    'const x = half + 1;',
  ].join('\n');
  const { src: out } = rewriteFile(src);
  // The string literal `"task #999:..."` must survive (walker correctly
  // identified `/ 2;` as division and then entered the string.
  assert.ok(out.includes('"task #999: keep me because I am in a string"'));
  assert.ok(!out.includes('// task #999: strip me'));
});

// Fresh-eyes P0 with date-only paren (no review-md coord).
test('strip: Fresh-eyes P0 (2026-07-18): dated variant → keep constraint', () => {
  const src = 'Fresh-eyes P0 (2026-07-18): expose `openDrill` so the empty-state';
  const out = rewriteCommentText(src);
  assert.equal(out, 'expose `openDrill` so the empty-state');
});

// Mid-sentence inline artifact refs. These leak through the leading-prefix
// strippers because they sit after commas / em-dashes / mid-sentence.
test('strip: em-dash inline Ticket ref → gone, sentence keeps meaning', () => {
  const src = 'raw-inject.js — Ticket #15 B (2026-07-17) envelope:raw classifier.';
  const out = rewriteCommentText(src);
  assert.ok(!/Ticket #15/.test(out), `got: ${out}`);
  assert.ok(/raw-inject\.js/.test(out));
  assert.ok(/envelope:raw classifier/.test(out));
});

test('strip: leading Ticket #NNN. sentence (no colon) → prefix gone', () => {
  // Comment starts `Ticket #140. Data source ...` — no colon, so the leading
  // stripper (which requires `[:：—]`) never fires. The inline-ticket-ref
  // rule handles it.
  const src = 'Ticket #140. Data source is the growth-v2 IPC compact-window.';
  const out = rewriteCommentText(src);
  assert.ok(!/Ticket #140/.test(out), `got: ${out}`);
  assert.ok(/Data source is the growth-v2 IPC/.test(out));
});

test('strip: mid-sentence — Ticket #140 explicitly says', () => {
  const src = 'Replace the pane body wholesale — Ticket #140 explicitly says "推倒";';
  const out = rewriteCommentText(src);
  assert.ok(!/Ticket #140/.test(out), `got: ${out}`);
  assert.ok(/Replace the pane body wholesale/.test(out));
  assert.ok(/explicitly says/.test(out));
});

test('strip: mid-sentence (team-lead §4.1 fix) reference', () => {
  const src = 'Title fallback (team-lead §4.1 fix): real-daemon truth from wire.';
  const out = rewriteCommentText(src);
  assert.ok(!/team-lead §4\.1/.test(out), `got: ${out}`);
  assert.ok(/Title fallback/.test(out));
  assert.ok(/real-daemon truth from wire/.test(out));
});

test('strip: mid-sentence , task #NNN comma-tagged', () => {
  const src = 'Empty-filter shared with mergeRecentSessions, task #69 caveat included.';
  const out = rewriteCommentText(src);
  assert.ok(!/task #69/.test(out), `got: ${out}`);
  assert.ok(/mergeRecentSessions/.test(out));
});

test('preserve: bare #NNN mid-sentence stays (team-lead (B) ruling)', () => {
  const src = 'The kernel PR #199 landed the recallable-compaction stack.';
  const out = rewriteCommentText(src);
  assert.equal(out, src);
});

// INTERNAL_DOC_STRIP hits at leading position must also consume the trailing
// delimiter (like the LEADING_STRIPPERS do), else we leave `: rest of body`.
// Regression: `// density-spec §4: rows focusable` was leaving `:` orphan.
test('strip: leading density-spec §N: followed by body → colon consumed', () => {
  const src = 'density-spec §4: rows focusable, Enter=L1';
  const out = rewriteCommentText(src);
  assert.ok(!/density-spec/.test(out));
  assert.equal(out, 'rows focusable, Enter=L1', `got: ${out}`);
});

test('strip: leading style-guide §N — body → dash-delim consumed', () => {
  const src = 'style-guide §3: full-width row is normative.';
  const out = rewriteCommentText(src);
  assert.ok(!/style-guide/.test(out));
  assert.equal(out, 'full-width row is normative.', `got: ${out}`);
});

// Widened task-num-prefix accepts a trailing tag-word and `.` as delimiter.
test('strip: Task #NNN word: prefix → gone', () => {
  const src = 'Task #49 lane: the desktop shell needs a live indicator.';
  const out = rewriteCommentText(src);
  assert.equal(out, 'the desktop shell needs a live indicator.', `got: ${out}`);
});

test('strip: Task #NNN two-word tag: prefix → gone', () => {
  const src = 'Task #225 selfie seam: the Tracing page projects rows.';
  const out = rewriteCommentText(src);
  assert.equal(out, 'the Tracing page projects rows.', `got: ${out}`);
});

test('strip: Task #NNN tag (paren). prefix → gone (period delim)', () => {
  const src = 'Task #103 P0-4 (2026-07-16). Fork enabled.';
  const out = rewriteCommentText(src);
  assert.equal(out, 'Fork enabled.', `got: ${out}`);
});

// dated-tag-prefix (2026-07-18 additions).
test('strip: 2026-07-17 delta: prefix → gone', () => {
  const src = '2026-07-17 delta: pill-style "60 tok" rather than bare "60"';
  const out = rewriteCommentText(src);
  assert.equal(out, 'pill-style "60 tok" rather than bare "60"', `got: ${out}`);
});

test('strip: 2026-07-17 addendum (...): prefix → gone', () => {
  const src = '2026-07-17 addendum (老板实拍指令，team-lead 转发): assemble the';
  const out = rewriteCommentText(src);
  assert.equal(out, 'assemble the', `got: ${out}`);
});

test('strip: Density-spec L0 budget: prefix → gone', () => {
  const src = 'Density-spec L0 budget: identity + gist + 2 metrics. We show 3.';
  const out = rewriteCommentText(src);
  assert.equal(out, 'identity + gist + 2 metrics. We show 3.', `got: ${out}`);
});

test('strip: Clickability audit fills (2026-07-17): prefix → gone', () => {
  const src = 'Clickability audit fills (docs/demo-clickability-audit.md 2026-07-17). Rest.';
  const out = rewriteCommentText(src);
  assert.ok(!/Clickability audit/.test(out), `got: ${out}`);
  assert.ok(/Rest/.test(out));
});

test('strip: pi-agent-ui-study §N without .md → gone', () => {
  const src = 'Adapter dot palette — mirrors the pi-agent-ui-study §2 adapter matrix.';
  const out = rewriteCommentText(src);
  assert.ok(!/pi-agent-ui-study/.test(out), `got: ${out}`);
  assert.ok(/adapter matrix/.test(out));
});
