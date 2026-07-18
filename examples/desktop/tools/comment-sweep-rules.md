# comment-sweep — classification rules

Owner: `lane-fresh-eyes-p0`  Status: DRAFT for team-lead review before baseline
lands.  Scope: `src/main/**`, `src/preload/**`, `src/renderer/**` (`.js` only;
tests intentionally out — test names carry ticket anchors used for the
regression audit trail).

## Bucket contract

Every scan hit lands in one of three buckets:

- **keep-stripped** — the surrounding comment carries a real constraint (why
  this order matters, what state exists, which wire contract is honored).
  Only the *artifact-reference prefix* is removed.  The sentence that follows
  is preserved verbatim, minus grammatical stitching (leading colon, spaces,
  connective particles).
- **delete-line** — the entire comment line is a process narrative that
  carries no invariant.  Remove the line, close the gap.
- **delete-block** — a multi-line comment whose SOLE purpose is process
  narrative (e.g. a header repeating "this file was refactored per §X.Y").
  Remove the whole `/* … */` or contiguous `// … // …` run.
- **skip** — do not touch.  See §Skip below.

## Family → default action

The scanner emits 18 families.  Defaults, each overridable per-hit during
review:

| family              | default action  | notes |
|---------------------|-----------------|-------|
| fresh-eyes-p0       | keep-stripped   | strip `Fresh-eyes P0 (date, review-fresh-eyes.md #N):` |
| fresh-eyes-plain    | keep-stripped   | strip `Fresh-eyes P0:` prefix |
| review-md-ref       | keep-stripped   | strip `(review-*.md #N)` parenthetical |
| ticket-letter       | keep-stripped   | strip `Ticket A/B/…:` — retain the constraint |
| ticket-num          | keep-stripped   | strip `Ticket #NNN:` — retain the constraint |
| task-num            | keep-stripped   | strip `task #NNN` mentions — retain the constraint |
| bare-hash-num       | context-dependent | if it's the only anchor a reader has for context (e.g. `#93` names a *design tension* explained elsewhere), keep the hash but note "kernel ticket #93" style — otherwise strip |
| round-shot          | keep-stripped   | drop `(QA round-N shot NN)` parenthetical |
| shot-num            | keep-stripped   | drop `shot NN` |
| rec-num             | keep-stripped   | strip `rec 22-bis` etc. |
| team-lead-ref       | keep-stripped   | strip `team-lead §X.Y` prefix — retain the described rule |
| boss-delta          | keep-stripped   | strip `老板实测 delta` / `205-Δ3` |
| date-prefix         | keep-stripped   | strip leading `YYYY-MM-DD` on comments whose body still makes sense without the date; delete-line if the date IS the whole comment |
| internal-doc-ref    | keep-stripped   | all internal-doc refs are stripped: `density-spec §N`, `style-guide §N`, `pi-agent-ui-study.md`, `LangSmith study §N rec M`, `trace-parity batch`, `trace-viz §N` — the OSS release pipeline excludes docs/design-refs/, so references would 404 for readers (team-lead 2026-07-18) |
| finding-letter      | keep-stripped   | `F-1 / F-2 / F-3 / F-4` are audit-round codes, strip |
| upstream-path       | keep-stripped   | `packages/foo/bar.ts:33-52` → replace with a concept name ("wire protocol v2 (`session/interrupt`)") — reader has no access to that path |
| phase-of-rec        | keep-stripped   | strip `phase N (pi/rec/task)` |
| port-audit          | keep-stripped   | strip `port 9224 wire audit` — the constraint isn't tied to a port number |
| e2e-audit           | keep-stripped   | strip `e2e audit` marker |
| audit-batch         | keep-stripped   | strip `Clickability audit D3` / `hygiene batch task 3` |

## Skip

Do not touch:

1. Any file NOT under `src/main/`, `src/preload/`, `src/renderer/`.
2. Test files (already excluded from the scan by SCAN_DIRS).
3. Any comment whose text is inside a string literal (`extractComments`
   already guards this).
4. Any hit where the artifact reference IS the identifier ("kernel `#218`"
   naming a specific PR whose numeric identity is the meaningful concept
   the reader needs — mark `bare-hash-num` skip per-case).
5. Any header banner comment at line 1 that documents the file's PUBLIC
   contract (imports, exported functions, module role) — even if it mentions
   a ticket, the reader wanted the file overview.  Strip only the ticket
   reference from within, don't touch the banner shape.

## Stripping recipe (mechanical)

The stripper reads a keep-stripped line and applies the following in order.
Each step is a pure text transform on the comment text (not the leading
`//` / ` * ` prefix — those are preserved to keep the block-comment shape).

```
1. Drop leading parenthetical  ^\s*\(([\w §.,#/-]+?)\)\s*[:—-]?\s*
   IF the parenthetical is composed entirely of family patterns.
2. Drop leading artifact-prefix + delimiter:
     ^\s*(Fresh-eyes P0[^:]*:\s*)
     ^\s*(Ticket #?\w+[^:]*:\s*)
     ^\s*(task #\d+[^:]*:\s*)
     ^\s*(F-\d+ \([^)]+\):\s*)
     ^\s*(20\d{2}-\d{2}-\d{2}\s*[·—-]?\s*)
     ^\s*(rec \d+[- ]?bis[^:]*:\s*)
     ^\s*(team[- ]lead §[\d.]+[^:]*:\s*)
3. Drop trailing artifact suffix:
     \s*\((?:round-\d+ ?shot ?\d+|QA round-\d+|review-[a-z-]+\.md #\d+|Ticket [A-Z#\d]+|task #\d+|Fresh-eyes P0)[^)]*\)\s*$
4. Collapse remaining "(task #N):"/"(#NNN)"/"(§X)" fragments in the middle
   of the sentence by dropping the parenthetical only, keeping the rest.
5. Normalise whitespace: trim, collapse multi-space, ensure one trailing
   line-ending style match.
6. If the remaining text is empty → mark for delete-line.
7. If the remaining text is a fragment (starts with lowercase and lacks a
   verb) → prepend a period-and-capital shim ONLY when the original had a
   sentence-starting shape; otherwise keep the fragment as-is (many are
   header labels like `-- forkChildLabel readability fix ----`).
```

Steps 1-4 are the load-bearing ones.  Step 5-7 are conservative — if in
doubt, leave the line to the human bucket pass.

## Two-commit split (per team-lead brief)

- **Commit A** — `src/main/*.js` + `src/preload/*.js` only.  ~13 files.
  Explicit `git add src/main/... src/preload/preload.js` per file.
  Message: `chore(comment-sweep): main+preload artifact-reference strip`
  followed by the per-family counters and total lines touched.
- **Commit B** — `src/renderer/*.js` only.  ~50 files.  Explicit git add.
  Message: `chore(comment-sweep): renderer artifact-reference strip`
  followed by the per-family counters and total lines touched.

## Acceptance for each commit

1. `node --check` passes on every changed `.js` file.
2. `node --test 'test/*.test.js' 2>&1 | tail -5` shows the same pass count
   as baseline (regression: 0 tests changed).
3. `git diff -w --stat` line count == count of stripped comment lines +
   count of deleted comment lines.  `git diff -w` output contains NO source
   lines (only lines starting with `-` or `+` inside a comment context).
4. Per-file `git show --stat` audit line: no file gains code or loses code;
   the sole shape of any diff hunk is comment-line change.
5. Commit message carries the per-family stats produced by
   `node tools/comment-sweep-scan.js --stats` before → after.

## Machine-readable classification

The classification bucket for every hit is stored in
`tools/comment-sweep-plan.jsonl` (one JSON object per line, keys:
`file`, `line`, `family`, `bucket`, `action`, `note`).  The mechanical
executor reads this and applies the strip recipe or deletion.  Any hit
whose bucket is `skip` or `human-review` is not touched.

## Reconciliation with test-real HEAD

The scan output above is against my worktree HEAD `6a44b8c` (branch
`fix/fresh-eyes-p0`).  The final baseline for this batch is test-real HEAD
AFTER `fix/oss-prep` + `fix/oss-clean` merge in.  Team-lead notifies when
that HEAD is ready.  Between now and then, the classification rules
themselves don't move; only the row set and line numbers do.  The
mechanical pass re-runs the scan on the new baseline and applies the
per-family rules; per-hit `human-review` decisions are re-matched by
(family, file, approximate line context).
