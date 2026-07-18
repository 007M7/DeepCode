#!/usr/bin/env node
/*
 * comment-sweep-scan.js
 *
 * Scan src/main, src/preload, src/renderer for "process-metadata" comment
 * prefixes — internal artifact references that leak into source (task/ticket
 * numbers, review filenames, dated fresh-eyes markers, team-lead section
 * pointers, in-house code-review IDs, round-N/shot-M etc.). Output one line
 * per hit as pipe-separated fields so downstream classification can be done
 * mechanically:
 *
 *   family|path|lineno|match|context
 *
 * The classification (keep-stripped / delete / skip) is NOT decided here.
 * This is a listing tool; humans (or a second pass) split the buckets.
 *
 * Usage:
 *   node tools/comment-sweep-scan.js               # print tsv
 *   node tools/comment-sweep-scan.js --json        # print jsonl
 *   node tools/comment-sweep-scan.js --stats       # count by family
 *   node tools/comment-sweep-scan.js --stats-file  # count by family x file
 *
 * Scope: only .js files under src/main, src/preload, src/renderer. Tests are
 * intentionally skipped (test names carry ticket anchors used for reconciling
 * regression coverage — stripping them would break the audit trail).
 *
 * Patterns are anchored to comment territory: we require the match to sit
 * inside //, /* * / (block open/mid), or trailing after a code line preceded
 * by //. Strings that happen to contain "task #157" won't match.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = ['src/main', 'src/preload', 'src/renderer'];
const EXCLUDE_BASENAMES = new Set([]); // test files live under test/, already out of SCAN_DIRS

// -----------------------------------------------------------------------------
// Pattern families
//
// Each family has a probe regex (matched against comment TEXT, case-insensitive
// unless noted) plus a short "why". The scan does not decide keep/delete —
// families exist so the sort/classify pass can group by shape.
// -----------------------------------------------------------------------------
const FAMILIES = [
  // Fresh-eyes P0 dated review reference. Shape:
  //   Fresh-eyes P0 (2026-07-18, review-fresh-eyes.md #N ...):
  //   Fresh-eyes (2026-07-18, review-fresh-eyes.md #N):
  { id: 'fresh-eyes-p0', re: /fresh[- ]eyes[^\n]*review[- ]fresh[- ]eyes\.md[^\n]*#\d+/i, why: 'F-11 dated review-file marker' },
  { id: 'fresh-eyes-plain', re: /\bfresh[- ]eyes\s+p0\b/i, why: 'F-11 fresh-eyes P0 prefix (no review-file coord)' },

  // Explicit review-file references (any review-*.md #N form).
  { id: 'review-md-ref', re: /review-[a-z0-9][\w-]*\.md\s*(?:#|item\s*)?\d*/i, why: 'F-11 review-*.md filename reference' },

  // Ticket letters (Ticket A/B/C/D/G) and their numeric siblings.
  { id: 'ticket-letter', re: /\bticket\s+[A-Z]\b/, why: 'F-10 Ticket A/B/... letter code' },
  { id: 'ticket-num', re: /\bticket\s*#\d+/i, why: 'F-10 Ticket #N number' },

  // task #N / #NNN in comments (JS uses # only for private, so # in a comment
  // is almost always an issue ticket).
  { id: 'task-num', re: /\btask\s*#\d+/i, why: 'F-10 task #NNN' },
  { id: 'bare-hash-num', re: /(?<![\w"'`])#\d{2,4}\b/, why: 'F-10 bare "#NNN" (issue/ticket)' },

  // Round/shot/wave markers ("round-6 shot 11", "Round-visual N1", "round-8").
  { id: 'round-shot', re: /\bround[- ]?\d+\b|\bround[- ]visual\s*[A-Z]?\d+/i, why: 'F-10 round-N/shot marker' },
  { id: 'shot-num', re: /\bshot\s*\d+\b/i, why: 'F-10 shot N marker' },

  // "rec 22-bis" / "rec §X.Y" / "recommendation NN".
  { id: 'rec-num', re: /\brec\s*\d+[- ]?bis\b|\brec\s*§\s*[\d.]+|\brecommendation\s*\d+/i, why: 'F-10 recommendation N/rec-N-bis' },

  // "team-lead §X.Y" / "team lead §X" — internal dispatch coord.
  { id: 'team-lead-ref', re: /team[- ]lead\s*(?:§|dispatch|verbatim|正面|指令|拍板)/i, why: 'F-11 team-lead §X.Y' },

  // 老板 / boss references + 实拍 / 实测 delta markers.
  { id: 'boss-delta', re: /老板\s*(?:实测|实拍|指令)|boss[- ]delta|205-Δ\d+/i, why: 'F-10 老板实测 delta / 实拍 marker' },

  // dated PROCESS prefix ("2026-07-17 老板实测", "2026-07-18 e2e audit"): a
  // date + narrative word close together at the START of a comment.
  { id: 'date-prefix', re: /^\s*(?:\/\/|\*)?\s*(?:20\d{2}-\d{2}-\d{2})\s*(?:老板|team|fresh|round|shot|delta|e2e|review|audit|Ticket|task|rec|冲刺|walkthrough)/im, why: 'F-13 dated process-metadata prefix' },

  // density-spec / study §X.Y coord (internal doc anchors).
  { id: 'internal-doc-ref', re: /(density[- ]spec|langsmith[- ](?:study|tracing)|trace[- ]parity(?:[- ]batch)?|pi[- ]agent[- ]ui[- ]study|trace[- ]viz)\s*§?\s*[\d.a-z-]+/i, why: 'F-10 internal doc §X.Y ref' },

  // "F-1 / F-2 / F-3 / F-4" e2e-audit finding letters bare in comments.
  { id: 'finding-letter', re: /\bF-\d{1,2}\b/, why: 'F-10 finding letter (F-N)' },

  // packages/*/src/*.ts:33-52 upstream path coordinates (F-20).
  { id: 'upstream-path', re: /packages\/[\w-]+\/[\w-]+\/src\/[\w./-]+\.ts:\d+/, why: 'F-20 upstream packages/*/src path coord' },

  // "wire audit port 9224" / port-based process artifact.
  { id: 'port-audit', re: /port\s*\d{4,5}\s*wire\s*audit|wire\s*audit\s*port\s*\d{4,5}/i, why: 'F-13 port NNNN wire audit marker' },

  // "phase 2 of rec X" / "phase N (pi §X.Y)".
  { id: 'phase-of-rec', re: /\bphase\s*\d+\s*\((?:pi|rec|task)/i, why: 'F-13 phase N (pi/rec/task) subordination' },

  // e2e audit / walkthrough dated batch.
  { id: 'e2e-audit', re: /\be2e[- ]audit\b|\bwalkthrough[- ](?:audit|shot|batch)\b/i, why: 'F-10 e2e-audit marker' },

  // Clickability audit D3 / hygiene batch task 3 style compound refs.
  { id: 'audit-batch', re: /clickability[- ]audit\s*[A-Z]?\d*|hygiene\s*batch\s*task\s*\d+|trace[- ]parity\s*batch\s*task\s*\d+/i, why: 'F-10 audit batch/task ref' },
];

// -----------------------------------------------------------------------------
// File discovery
// -----------------------------------------------------------------------------
function listJsFiles() {
  const results = [];
  for (const dir of SCAN_DIRS) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    walk(abs, results);
  }
  return results;
}
function walk(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walk(p, out);
      continue;
    }
    if (!ent.isFile()) continue;
    if (!/\.(js|mjs|cjs)$/.test(ent.name)) continue;
    if (EXCLUDE_BASENAMES.has(ent.name)) continue;
    out.push(p);
  }
}

// -----------------------------------------------------------------------------
// Comment extraction. We stream the file char-by-char to know when we're
// inside //, /* */, or a string. Every comment span is emitted with its
// starting line number so downstream can report file:line accurately.
// -----------------------------------------------------------------------------
function extractComments(src) {
  const spans = []; // { line, text, kind: 'line'|'block' }
  const N = src.length;
  let i = 0;
  let line = 1;
  let inStr = null; // "'", '"', '`'
  while (i < N) {
    const c = src[i];
    const next = src[i + 1];
    if (inStr) {
      if (c === '\\') { i += 2; if (src[i - 1] === '\n') line++; continue; }
      if (c === inStr) { inStr = null; i++; continue; }
      if (c === '\n') line++;
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      inStr = c;
      i++;
      continue;
    }
    if (c === '/' && next === '/') {
      const startLine = line;
      let j = i + 2;
      while (j < N && src[j] !== '\n') j++;
      const text = src.slice(i + 2, j);
      spans.push({ line: startLine, text, kind: 'line' });
      i = j;
      continue;
    }
    if (c === '/' && next === '*') {
      const startLine = line;
      let j = i + 2;
      const startIdx = j;
      while (j < N && !(src[j] === '*' && src[j + 1] === '/')) {
        if (src[j] === '\n') line++;
        j++;
      }
      const raw = src.slice(startIdx, j);
      // Emit one span per LINE in the block so line numbers are meaningful.
      const lines = raw.split('\n');
      let ln = startLine;
      for (const l of lines) {
        spans.push({ line: ln, text: l, kind: 'block' });
        ln++;
      }
      i = j + 2;
      continue;
    }
    if (c === '\n') line++;
    i++;
  }
  return spans;
}

// -----------------------------------------------------------------------------
// Main scan
// -----------------------------------------------------------------------------
function scanFile(abs) {
  const rel = path.relative(ROOT, abs);
  const src = fs.readFileSync(abs, 'utf8');
  const spans = extractComments(src);
  const hits = [];
  for (const span of spans) {
    const t = span.text;
    if (!t.trim()) continue;
    for (const f of FAMILIES) {
      const m = f.re.exec(t);
      if (m) {
        hits.push({
          family: f.id,
          why: f.why,
          path: rel,
          line: span.line,
          match: m[0].trim(),
          context: t.trim().slice(0, 200),
        });
      }
    }
  }
  return hits;
}

function main() {
  const args = process.argv.slice(2);
  const mode = args.includes('--json') ? 'json'
    : args.includes('--stats-file') ? 'stats-file'
    : args.includes('--stats') ? 'stats'
    : 'tsv';

  const files = listJsFiles();
  const hits = [];
  for (const f of files) {
    for (const h of scanFile(f)) hits.push(h);
  }

  if (mode === 'tsv') {
    for (const h of hits) {
      // pipe-separated so awk/cut/sort work; strip pipes/newlines from context
      const ctx = h.context.replace(/\|/g, '¦').replace(/[\r\n]+/g, ' ');
      process.stdout.write(`${h.family}|${h.path}|${h.line}|${h.match}|${ctx}\n`);
    }
  } else if (mode === 'json') {
    for (const h of hits) process.stdout.write(JSON.stringify(h) + '\n');
  } else if (mode === 'stats') {
    const by = new Map();
    for (const h of hits) by.set(h.family, (by.get(h.family) || 0) + 1);
    const total = hits.length;
    const rows = [...by.entries()].sort((a, b) => b[1] - a[1]);
    for (const [k, v] of rows) process.stdout.write(`${v.toString().padStart(4)}  ${k}\n`);
    process.stdout.write(`${'-'.repeat(6)}\n${total.toString().padStart(4)}  TOTAL hits\n`);
    process.stdout.write(`${files.length.toString().padStart(4)}  files scanned\n`);
  } else if (mode === 'stats-file') {
    const by = new Map(); // path -> Map(family -> count)
    for (const h of hits) {
      if (!by.has(h.path)) by.set(h.path, new Map());
      const inner = by.get(h.path);
      inner.set(h.family, (inner.get(h.family) || 0) + 1);
    }
    const rows = [...by.entries()].sort((a, b) => {
      const at = [...a[1].values()].reduce((x, y) => x + y, 0);
      const bt = [...b[1].values()].reduce((x, y) => x + y, 0);
      return bt - at;
    });
    for (const [p, inner] of rows) {
      const total = [...inner.values()].reduce((x, y) => x + y, 0);
      process.stdout.write(`${total.toString().padStart(4)}  ${p}\n`);
      const fams = [...inner.entries()].sort((a, b) => b[1] - a[1]);
      for (const [f, c] of fams) process.stdout.write(`      ${c.toString().padStart(3)}  ${f}\n`);
    }
  }
}

if (require.main === module) main();
module.exports = { extractComments, FAMILIES, scanFile, listJsFiles };
