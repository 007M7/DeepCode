#!/usr/bin/env node
/*
 * comment-sweep-apply.js
 *
 * Mechanical stripper. Reads every .js file under src/main, src/preload,
 * src/renderer and applies the artifact-reference strip recipe from
 * tools/comment-sweep-rules.md.
 *
 * The stripping is conservative: it edits only comment TEXT (the run of
 * characters after `//` or inside `/* … *\/`), not code. If a comment line
 * becomes empty after stripping we delete the line; otherwise we rewrite
 * the comment in-place, preserving the leading `//` or ` * ` / `/*` / `*\/`
 * shape.
 *
 * Usage:
 *   node tools/comment-sweep-apply.js --dry-run    # print planned edits, don't write
 *   node tools/comment-sweep-apply.js --apply      # write files in place
 *   node tools/comment-sweep-apply.js --scope=main     # main+preload only
 *   node tools/comment-sweep-apply.js --scope=renderer # renderer only
 *
 * Scope split maps 1:1 onto the two commits (main+preload / renderer) the
 * team-lead brief calls for.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCOPES = {
  main: ['src/main', 'src/preload'],
  renderer: ['src/renderer'],
  all: ['src/main', 'src/preload', 'src/renderer'],
};

// -----------------------------------------------------------------------------
// Strip recipe. Each rule is (pattern, replacement, description). Applied in
// order; a rule may match zero, one, or multiple times per line. Rules 1-4
// (LEADING) run only against the START of the comment text.
// -----------------------------------------------------------------------------

// LEADING artifact-prefix rules. Each captures the prefix + trailing
// delimiter (`:` / `—` / `.` / `,`). Applied only if the match starts at
// column 0 of the comment text.
const LEADING_STRIPPERS = [
  // Fresh-eyes P0 (2026-07-18, review-fresh-eyes.md #4 [+ team-lead follow-up]):
  { name: 'fresh-eyes-p0-full', re: /^\s*Fresh[- ]eyes\s+P0\s*\([^)]*review[- ]fresh[- ]eyes\.md[^)]*\)\s*[:：—]?\s*/i },
  // Fresh-eyes P0 (2026-07-18):  — dated but no review-md coord
  { name: 'fresh-eyes-p0-dated', re: /^\s*Fresh[- ]eyes\s+P0\s*\([^)]*\)\s*[:：—]\s*/i },
  // Fresh-eyes P0: (bare)
  { name: 'fresh-eyes-p0-bare', re: /^\s*Fresh[- ]eyes\s+P0\s*[:：—]\s*/i },
  // Ticket #NNN [X] [(2026-07-17)] [phase 2 (pi §2.3)]: prefix (matches ticket-letter and ticket-num)
  { name: 'ticket-num-prefix', re: /^\s*Ticket\s+#?\d+(?:\s+[A-Z])?(?:\s*\([^)]*\))?(?:\s+step\s+\d+|\s+phase\s+\d+(?:\s*\([^)]*\))?)?\s*[:：—]\s*/i },
  { name: 'ticket-letter-prefix', re: /^\s*Ticket\s+[A-Z](?:\s*\([^)]*\))?\s*[:：—]\s*/ },
  // task #NNN [/ trace-viz §X.Y] [(2026-07-17…)] [rec 22-bis[…]] [phase 2 (pi §2.3)]:
  //
  // The `/ …` continuation matches compound refs like
  //   task #201 / trace-viz §4d:
  //   task #158 / density-spec §3:
  // where the reader wanted "here is what the constraint is called in two
  // artifact systems". We drop the whole pileup.
  //
  // Widened 2026-07-18: also accept a small trailing tag word or two before
  // the delimiter, and `.` as an end-of-prefix delim in addition to `:`/`：`/`—`.
  // Handles the pi-style `Task #49 lane:`, `Task #225 selfie seam:`,
  // `Task #103 P0-4 (2026-07-16).` shapes.
  { name: 'task-num-prefix', re: /^\s*(?:Task|task)\s*#\d+(?:\s*\/\s*[\w §.a-z-]+)?(?:\s+[\w-]+(?:\s+[\w-]+)?)?(?:\s*\([^)]*\))?(?:\s+rec\s+[\d-]+(?:-bis)?)?(?:\s+phase\s+\d+(?:\s*\([^)]*\))?)?\s*[:：—.]\s*/ },
  // F-N (2026-07-18 e2e audit): prefix
  { name: 'finding-letter-prefix', re: /^\s*F-\d+\s*\([^)]*(?:audit|e2e)[^)]*\)\s*[:：—]\s*/i },
  // team-lead §X.Y [ruling|正面参照|dispatch verbatim] [(...)]:
  { name: 'team-lead-prefix', re: /^\s*[Tt]eam[- ]lead\s+§[\d.]+(?:\s+\w+)?(?:\s*\([^)]*\))?\s*[:：—]\s*/ },
  // rec 22-bis [(2026-07-17|pi §X.Y)]:
  { name: 'rec-num-prefix', re: /^\s*rec\s+\d+(?:-bis)?(?:\s+phase\s+\d+)?(?:\s*\([^)]*\))?\s*[:：—]\s*/i },
  // Round-visual N1 (2026-07-16):
  { name: 'round-visual-prefix', re: /^\s*Round[- ]visual\s+[A-Z]?\d+(?:\s*\([^)]*\))?\s*[:：—]\s*/i },
  // Clickability audit D3 [fix] (2026-07-17):
  { name: 'audit-batch-prefix', re: /^\s*(?:Clickability\s+audit|hygiene\s+batch|trace[- ]parity\s+batch)\s+[\w\d]+(?:\s+\w+)?(?:\s*\([^)]*\))?\s*[:：—]\s*/i },
  // 2026-07-XX round-N shot NN:  (dated e2e/round prefix)
  { name: 'dated-round-prefix', re: /^\s*20\d{2}-\d{2}-\d{2}\s+(?:round|QA|e2e|老板|walkthrough|trace[- ]parity)[^:：]*[:：—]\s*/ },
  // 2026-07-XX delta:  /  2026-07-XX addendum (...):  — generic process
  // banner starting with a date + one-word tag.
  { name: 'dated-tag-prefix', re: /^\s*20\d{2}-\d{2}-\d{2}\s+\w+(?:\s*\([^)]*\))?\s*[:：—]\s*/ },
  // Clickability audit fills (...2026-07-17): — audit-batch-prefix widened
  // to accept the trailing "fills"/word before the paren+delim.
  { name: 'audit-batch-fills-prefix', re: /^\s*Clickability\s+audit\s+\w+(?:\s*\([^)]*\))?\s*[:：—]?\s*/i },
  // Density-spec L0 budget:  — density-spec followed by L\d level ref
  // instead of §N (LangSmith-style level naming).
  { name: 'density-spec-level-prefix', re: /^\s*[Dd]ensity[- ]spec\s+L\d[^:：]*[:：]\s*/ },
];

// TRAILING (parenthetical) rules. Applied to the whole comment text; may
// match at any position. Non-greedy.
const TRAILING_STRIPPERS = [
  // (Fresh-eyes P0 (2026-07-18, review-fresh-eyes.md #N))  — nested variant
  { name: 'paren-fresh-eyes', re: /\s*\(\s*Fresh[- ]eyes\s+P0[^()]*review[- ]fresh[- ]eyes\.md[^()]*\)/gi },
  // (review-fresh-eyes.md #N) / (review-*.md #N)
  { name: 'paren-review-md', re: /\s*\(review-[a-z][\w-]*\.md\s*#\d+\)/gi },
  // (QA round-N shot NN)
  { name: 'paren-qa-round', re: /\s*\(QA\s+round-\d+(?:\s+shot\s+\d+)?\)/gi },
  // (round-N) / (round-N shot NN)
  { name: 'paren-round', re: /\s*\(round-\d+(?:\s+shot\s+\d+)?\)/gi },
  // (2026-07-17|老板实测|team-lead §X.Y|正面参照)  — mixed process paren
  { name: 'paren-dated-process', re: /\s*\((?:20\d{2}-\d{2}-\d{2})[^()]*(?:老板|team[- ]lead|正面|指令|walkthrough|e2e[- ]audit|round-\d)[^()]*\)/gi },
  // (Ticket #N) / (task #N) as trailing tag, incl. trailing tokens like
  //   (task #103 P0-4, 2026-07-16)
  //   (task #37 layer 1)
  //   (2026-07-17, task #49)   — leading-date variant
  { name: 'paren-ticket-num', re: /\s*\((?:Ticket|task)\s*#?\d+(?:[,\s][^()]*)?\)/gi },
  { name: 'paren-dated-task', re: /\s*\(20\d{2}-\d{2}-\d{2}\s*,\s*(?:Ticket|task)\s*#?\d+(?:[,\s][^()]*)?\)/gi },
  // 205-Δ3 / 205-Δ4 boss-delta bare tag with trailing punctuation
  { name: 'inline-boss-delta', re: /\s*\b205-Δ\d+\b/g },
  // (F-1 …)
  { name: 'paren-finding', re: /\s*\(F-\d+(?:\s*[,;]\s*\d{4}-\d{2}-\d{2}[^)]*)?\)/g },
  // packages/x/y/z.ts:33-52  → strip. If the coord sat inside its own paren
  // `(packages/foo.ts:33-52)`, drop the paren too so we don't leave empty
  // "wire () carries..." debris.
  { name: 'upstream-path-paren', re: /\s*\(packages\/[\w-]+\/[\w-]+\/src\/[\w./-]+\.ts:\d+(?:-\d+)?\)/g },
  { name: 'upstream-path', re: /\s*\bpackages\/[\w-]+\/[\w-]+\/src\/[\w./-]+\.ts:\d+(?:-\d+)?/g },
  // Compound "QA round-N shot NN" as a bare inline tag (must run BEFORE
  // inline-round so we don't leave "QA shot NN" debris).
  { name: 'inline-qa-round-shot', re: /\s*\bQA\s+round-\d+\s+shot\s+\d+\b/gi },
  // rec 22-bis / rec 22 as a mid-sentence tag (bare word)
  { name: 'inline-rec', re: /\s*\brec\s+\d+(?:-bis)?/g },
  // Round-N tag mid-sentence
  { name: 'inline-round', re: /\s*\bround-\d+\b/gi },
  // Orphan closing `)` LEFT AS THE ENTIRE line body after an upstream-path
  // strip (source line was `path.ts:295-296):` — the strip removed the path
  // but not the parenthesis because it opened on a prior line). Only fires
  // when the body reduces to `)` or `):` with no other content.
  { name: 'orphan-close-paren', re: /^\s*\)\s*[:：]?\s*$/ },
  // Mid-sentence `Ticket #NNN [A-Z] [(2026-…)]` reference — a leftover after
  // the leading-prefix strippers didn't fire because the artifact ref sat
  // inside a longer sentence like:
  //   `— Ticket #140 explicitly says "推倒重来"`
  //   `Ticket #140. Data source is the growth-v2 IPC`
  //   `raw-inject.js — Ticket #15 B (2026-07-17) envelope:'raw' classifier.`
  // Distinct from paren-ticket-num because the artifact ref is bare (no
  // enclosing parens). Bare `Ticket #NNN` is an unambiguous internal artifact
  // reference (unlike bare `#NNN` which per team-lead (B) 2026-07-18 stays as
  // an OSS-verifiable official-repo PR anchor).
  { name: 'inline-ticket-ref', re: /\s*\bTicket\s+#\d+(?:\s+[A-Z])?(?:\s*\([^)]{0,50}\))?(?:\s+(?:step|phase)\s+\d+)?/g },
  // Mid-sentence `team-lead §X.Y [tag]` reference.
  { name: 'inline-team-lead-ref', re: /\s*\b[Tt]eam[- ]lead\s+§[\d.]+(?:\s+\w+)?/g },
  // Mid-sentence `task #NNN` — the leading-prefix stripper needs a `:`
  // delimiter; sentences like `strategy list, task #136` or
  // `mergeRecentSessions (task #69 — foo)` leak through.
  { name: 'inline-task-num-ref', re: /\s*[,;]?\s*\btask\s+#\d+\b/g },
];

// INTERNAL doc references. The OSS release pipeline strips
// docs/design-refs/ from the shipped artefact, so a reader who follows a
// `density-spec §N` or `style-guide` reference hits a 404 in the published
// tree. Team-lead directive (2026-07-18): dangling references are worse than
// missing ones — strip both. INTERNAL_DOC_KEEP is intentionally empty; the
// STRIP list covers every internal-only doc pointer we know about.
const INTERNAL_DOC_KEEP = [];
const INTERNAL_DOC_STRIP = [
  { re: /\s*\bpi[- ]agent[- ]ui[- ]study(?:\.md)?\s*§[\d.]+/gi, name: 'pi-study' },
  { re: /\s*\bLangSmith\s+study\s+§[\d.]+(?:\s+rec\s+\d+)?/gi, name: 'langsmith-study' },
  { re: /\s*\btrace[- ]parity(?:\s+batch)?(?:\s+task\s+\d+)?/gi, name: 'trace-parity-batch' },
  { re: /\s*\btrace[- ]viz\s+§[\d.a-z]+/gi, name: 'trace-viz-ref' },
  // density-layering spec references — repo-internal doc, stripped from OSS
  // artefact so references would 404. Matches `density-spec §N`, `density spec §N.M`.
  { re: /\s*\bdensity[- ]spec\s*§[\d.a-z]+(?:\s*·\s*[\w-]+)?/gi, name: 'density-spec' },
  { re: /\s*\bdensity[- ]layering[- ]spec\s*§[\d.a-z]+/gi, name: 'density-layering-spec' },
  // style-guide references — same reason.
  { re: /\s*\bstyle[- ]guide\s*(?:§[\d.a-z]+)?/gi, name: 'style-guide' },
];

// -----------------------------------------------------------------------------
// Comment-aware line rewriter.
//
// A file is edited by walking its comment spans (produced identically to
// comment-sweep-scan.js) and rewriting each span's text. Two shapes:
//   - // line comment  → text = everything after //
//   - /* … */ block    → each internal line is treated independently; the
//                         leading ` * ` (or `   `) prefix is preserved.
//
// After rewriting, the file is emitted with:
//   - Empty // lines → line removed entirely (including trailing \n).
//   - Empty ` * ` lines in a block comment → line removed if the block still
//     has non-empty lines around it; if the whole block becomes empty, the
//     entire /* */ span is removed.
// -----------------------------------------------------------------------------

function rewriteCommentText(text) {
  const originalLeadingWs = (text.match(/^\s*/) || [''])[0];
  let out = text;
  // Sentinel-guard PRE-EXISTING empty parens `()` so the paren-cleanup below
  // (added to collapse `(density-spec §3)` → gone after INTERNAL_DOC_STRIP
  // consumes the content) doesn't clobber legitimate function-call references
  // inside comments, e.g. `daemon.ensureUp()` / `refreshSessionList()`.
  // Any `()` that survives all strips into the output is one we created; the
  // sentinel-restored ones were there in the source and stay.
  const EMPTY_PAREN_MARK = ' EMPTYPAREN ';
  out = out.replace(/\(\s*\)/g, EMPTY_PAREN_MARK);
  let leadStripped = false;
  // Leading strippers first. Track whether any leading rule fired so cleanup
  // knows whether to consume leading whitespace.
  for (const rule of LEADING_STRIPPERS) {
    const before = out;
    out = out.replace(rule.re, '');
    if (out !== before) leadStripped = true;
  }
  // Trailing / inline strippers (do NOT flip leadStripped — they don't touch
  // the line's leading whitespace).
  for (const rule of TRAILING_STRIPPERS) {
    out = out.replace(rule.re, '');
  }
  for (const rule of INTERNAL_DOC_STRIP) {
    const before = out;
    out = out.replace(rule.re, '');
    // If the strip fired AT THE START of the (possibly-already-partially-
    // stripped) text — INTERNAL_DOC_STRIP entries are inline-anywhere, so a
    // leading occurrence like `density-spec §4: rows focusable` used to leave
    // a `: rows focusable` orphan. Treat leading-position hits as leadStripped
    // so the cleanup below eats the stray delimiter.
    if (out !== before) {
      // Detect leading position by checking whether the pre-strip text started
      // (after any whitespace) with a match of this same rule.
      const leadingRe = new RegExp('^' + rule.re.source.replace(/^\\s\*/, '\\s*'), rule.re.flags.replace('g', ''));
      if (leadingRe.test(before)) leadStripped = true;
    }
  }
  if (leadStripped) {
    // A leading strip fired. Clean up the debris (whitespace + orphan
    // delimiters) it may have left, then restore the ORIGINAL leading
    // whitespace so a bullet in `   - foo` inside a block comment keeps
    // its indent.
    out = out.replace(/^\s+/, '').replace(/^[:：—]\s*/, '');
    if (out) out = originalLeadingWs + out;
  }
  // Clean up empty parens `()` left behind when a strip consumed the sole
  // content of a parenthetical (`(packages/foo.ts:33-52)` → `()`). Guarded
  // above: pre-existing empty parens were replaced with a sentinel first.
  out = out.replace(/\s*\(\s*\)/g, '');
  // Restore any pre-existing empty parens.
  out = out.split(EMPTY_PAREN_MARK).join('()');
  // Deliberately NOT collapsing " ." → "." — the transform must never touch
  // spacing that predates our strip. Leaving occasional " ." debris is fine;
  // reviewers can spot and fix by hand, and we don't risk munging code-shape
  // comments like `// [a, b, ...]` where the space matters.
  if (/^[\s.:,;—]*$/.test(out)) return '';
  return out;
}

function rewriteFile(src) {
  // Walk char-by-char (mirror of comment-sweep-scan's extractComments) and
  // build a new string, replacing each comment's TEXT via rewriteCommentText.
  //
  // State tracking:
  //   - inStr = string literal char (' " `) currently open, or null.
  //   - inRegex = true iff currently inside a /.../ literal.
  //   - lastMeaningful = last non-whitespace char emitted; used to disambiguate
  //     `/` as regex-start vs division. If lastMeaningful is one of
  //     `=(,;!&|?:{}[` or empty (BOF) or after a keyword, `/` starts a regex.
  //     Otherwise (after ident/number/)/]) it's division.
  const N = src.length;
  let out = '';
  let i = 0;
  let inStr = null;
  let inRegex = false;
  let inRegexClass = false;
  let lastMeaningful = '';
  const REGEX_START_AFTER = new Set([
    '', '=', '(', ',', ';', '!', '&', '|', '?', ':', '{', '}', '[',
    '+', '-', '*', '%', '^', '~', '<', '>',
  ]);
  const KEYWORD_BEFORE_REGEX = /(?:^|[^\w$])(?:return|typeof|instanceof|in|of|delete|void|new|throw|yield|await|case|do|else)$/;
  function isRegexStartContext() {
    if (lastMeaningful === '') return true;
    if (REGEX_START_AFTER.has(lastMeaningful)) return true;
    // Check for keyword ending at `out`. Cheap: last 10 chars.
    const tail = out.slice(-12);
    if (KEYWORD_BEFORE_REGEX.test(tail)) return true;
    return false;
  }
  const stripped = { lines: 0, blocks: 0, inlineEdits: 0 };
  while (i < N) {
    const c = src[i];
    const next = src[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\' && i + 1 < N) { out += src[i + 1]; i += 2; continue; }
      if (c === inStr) { inStr = null; lastMeaningful = c; }
      i++;
      continue;
    }
    if (inRegex) {
      out += c;
      if (c === '\\' && i + 1 < N) { out += src[i + 1]; i += 2; continue; }
      if (c === '[') inRegexClass = true;
      else if (c === ']') inRegexClass = false;
      else if (c === '/' && !inRegexClass) { inRegex = false; lastMeaningful = c; }
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      inStr = c;
      out += c;
      lastMeaningful = c;
      i++;
      continue;
    }
    if (c === '/' && next === '/') {
      // Line comment. Find the // start's "leading whitespace on this line".
      let lineStart = out.lastIndexOf('\n') + 1;
      const leading = out.slice(lineStart);
      // Find end of comment (next newline).
      let j = i + 2;
      while (j < N && src[j] !== '\n') j++;
      const commentBody = src.slice(i + 2, j);
      const originalWasEmpty = commentBody.trim() === '';
      const rewritten = rewriteCommentText(commentBody);
      if (originalWasEmpty) {
        // Preserve empty `//` separator lines verbatim — the file's author
        // put them there as visual padding between paragraphs, not as a
        // side-effect of any strip.
        out += '//' + commentBody;
      } else if (rewritten === '') {
        // The line's body was 100% artifact-reference AND non-empty. Drop
        // the whole line (including leading indent + trailing newline).
        out = out.slice(0, lineStart);
        if (src[j] === '\n') j++;
        stripped.lines++;
      } else {
        // The rewritten text already includes whatever leading whitespace
        // rewriteCommentText decided to preserve; we just prepend `//`.
        const newComment = '//' + rewritten;
        if (newComment !== '//' + commentBody) stripped.inlineEdits++;
        out += newComment;
      }
      i = j;
      continue;
    }
    if (c === '/' && next === '*') {
      // Block comment. Collect the entire span first.
      let j = i + 2;
      while (j < N && !(src[j] === '*' && src[j + 1] === '/')) j++;
      const raw = src.slice(i + 2, j);
      const closeAt = j + 2;
      // Split into lines, rewrite each internal line while preserving the
      // ` * ` / ` *` / `   ` prefix shape.
      const lines = raw.split('\n');
      const rewrittenLines = [];
      let anyRealText = false;
      for (let idx = 0; idx < lines.length; idx++) {
        const l = lines[idx];
        // Detect ` * ` prefix (typical). Preserve indent + optional " * ".
        const m = l.match(/^(\s*)(\*\s?)?(.*)$/);
        const indent = m[1] || '';
        const star = m[2] || '';
        const body = m[3] || '';
        if (!body.trim()) {
          // Blank comment line — keep as-is (structural padding).
          rewrittenLines.push(l);
          continue;
        }
        const rewritten = rewriteCommentText(body);
        if (rewritten === '') {
          // Line body was 100% artifact reference. Drop it.
          // If the next line is also empty or drops, we compress; otherwise
          // we emit nothing here.
          stripped.blocks++;
          continue;
        }
        rewrittenLines.push(indent + star + rewritten);
        anyRealText = true;
      }
      if (!anyRealText && rewrittenLines.every((ll) => !ll.trim())) {
        // The entire block became empty (only structural blanks). Remove
        // the whole `/* … */` and its trailing newline if present.
        // Also remove the leading indentation on the line the /* opened on.
        let lineStart = out.lastIndexOf('\n') + 1;
        out = out.slice(0, lineStart);
        let k = closeAt;
        if (src[k] === '\n') k++;
        i = k;
        stripped.blocks++;
        continue;
      }
      out += '/*' + rewrittenLines.join('\n') + '*/';
      i = closeAt;
      continue;
    }
    // Regex-literal detection: `/` that is not `//` (line comment) nor `/*`
    // (block comment) AND appears in a regex-start context begins a `/…/` and
    // must be skipped so its internal `"` / `'` chars don't fool the string
    // tracker (bug: `/model\s+"([^"]+)"/i` was leaving the walker "in string"
    // for the rest of the file).
    if (c === '/' && next !== '/' && next !== '*' && isRegexStartContext()) {
      inRegex = true;
      inRegexClass = false;
      out += c;
      lastMeaningful = c;
      i++;
      continue;
    }
    out += c;
    if (!/\s/.test(c)) lastMeaningful = c;
    i++;
  }
  return { src: out, stripped };
}

// -----------------------------------------------------------------------------
// File discovery + CLI
// -----------------------------------------------------------------------------
function listJsFiles(scopes) {
  const results = [];
  for (const dir of scopes) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    walk(abs, results);
  }
  return results;
}
function walk(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) { walk(p, out); continue; }
    if (!ent.isFile()) continue;
    if (!/\.(js|mjs|cjs)$/.test(ent.name)) continue;
    out.push(p);
  }
}

function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const dry = args.includes('--dry-run') || !apply;
  const scopeArg = (args.find((a) => a.startsWith('--scope=')) || '--scope=all').split('=')[1];
  const scopes = SCOPES[scopeArg];
  if (!scopes) {
    console.error(`unknown --scope=${scopeArg}; use main|renderer|all`);
    process.exit(2);
  }

  const files = listJsFiles(scopes);
  let totalLines = 0;
  let totalBlocks = 0;
  let totalInline = 0;
  let touched = 0;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const { src: out, stripped } = rewriteFile(src);
    if (out === src) continue;
    touched++;
    totalLines += stripped.lines;
    totalBlocks += stripped.blocks;
    totalInline += stripped.inlineEdits;
    const rel = path.relative(ROOT, f);
    const summary = `(-${stripped.lines} full-line, -${stripped.blocks} block-line, ~${stripped.inlineEdits} inline)`;
    if (dry) {
      process.stdout.write(`~ ${rel}   ${summary}\n`);
    } else {
      fs.writeFileSync(f, out);
      process.stdout.write(`M ${rel}   ${summary}\n`);
    }
  }
  process.stdout.write(`---\n`);
  process.stdout.write(`${touched} files ${dry ? 'would be' : ''} touched; -${totalLines} full-line deletions, -${totalBlocks} block-line deletions, ~${totalInline} inline edits\n`);
}

if (require.main === module) main();
module.exports = { rewriteCommentText, rewriteFile };
