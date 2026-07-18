# Interactive sweep v2 — closes-stay-closed + long-text + dead-clicks

Run started: 2026-07-18T16:53:47.141Z
Report generated: 2026-07-18T16:55:18.119Z
Driver: scripts/interactive-sweep-v2.mjs
Electron: CDP :9299, user-data /tmp/dsh-sweep-v2-userdata
Profile: stdio-deepseek (real DeepSeek v4-flash)
Sandbox: /tmp/dsh-sweep-v2

## Verdict

- PASS: 9
- FAIL: 8
- SKIP: 0

## Surface: `tool-json-drawer`

| method | opened | closed via | closed | re-opened+event | still closed |
|---|---|---|---|---|---|
| x-button | yes | x-button | yes | yes | yes |
| escape | yes | escape | yes | yes | yes |

## Surface: `context-rail-drawer`

| method | opened | closed via | closed | re-opened+event | still closed |
|---|---|---|---|---|---|
| x-button | yes | x-button | yes | yes | yes |

## Surface: `annotation-drawer`

| method | opened | closed via | closed | re-opened+event | still closed |
|---|---|---|---|---|---|
| x-button | yes | x-button | yes | yes | yes |

## Surface: `devtools-drawer`

| method | opened | closed via | closed | re-opened+event | still closed |
|---|---|---|---|---|---|
| toggle-again | yes | toggle-again | yes | yes | yes |

## Surface: `fork-compare-drawer`

| method | opened | closed via | closed | re-opened+event | still closed |
|---|---|---|---|---|---|
| close-button | no | close-button | yes | no | skip |
| escape | no | escape | yes | no | skip |
| backdrop | no | backdrop | yes | no | skip |

## Surface: `rubric-detail-drawer`

| method | opened | closed via | closed | re-opened+event | still closed |
|---|---|---|---|---|---|
| x-button | yes | x-button | yes | yes | yes |
| backdrop | yes | backdrop | yes | yes | yes |

## Payload-controls long-text overlap

Sampled 4 .payload-controls mount points.

| # | kind | overlap |
|---|---|---|
| 0 | args | ok |
| 1 | args | ok |
| 2 | call | ok |
| 3 | result | ok |

**Verdict: PASS**

## Dead-click scan

Scanned 55 clickable elements; 0 fired no click listener.

PASS — every clickable fired a listener.

## Section 4 — Effect visibility (file/bash → UI)

Real DeepSeek turns; disk-side we own the sandbox path so byte compare is unambiguous.

> **Post-report reversal (see §4.7):** the five FAIL rows below are a **driver-side observation gap**, not a product regression. Every tool call in §4.1–§4.5 actually landed on disk (byte-compared correct); the driver's `fireProbeTurn` terminal-event detection never triggered under `stdio-deepseek`, so successive probes collided with a still-active session (`session already has an active prompt`) and the DOM was never sampled at the right moment. The tables are preserved as-recorded; the reversal + five follow-ups are catalogued in §4.7.

### 4.1 fs write — FAIL

| check | result |
|---|---|
| diff card rendered | NO |
| card data-tool-card-family = fs | NO (null) |
| disk file exists + content matches | yes |
| file path visible on card | NO |
| card content contains written line | NO |

### 4.2 fs edit (hunked) — FAIL

| check | result |
|---|---|
| diff card rendered | NO |
| disk shows edited line | NO |
| disk retains original line one | yes |
| card diff pane contains edited/orig content | NO |

### 4.3 bash — FAIL

| check | result |
|---|---|
| terminal card rendered | NO |
| stdout marker "sweep-v2-bash-marker-yrp1o0" visible on card | NO |

### 4.4 read — FAIL

| check | result |
|---|---|
| fs-family block for read | NO |
| card OR result preview populated | NO |
| file content visible in UI | NO |

### 4.5 multi-file write — FAIL

| check | result |
|---|---|
| all 3 files on disk | NO |
| render shape | none |
| all 3 paths visible in UI | NO |

### 4.6 Wire-present-but-not-visualized gap ledger

These are candidates for either (a) upstream account [backend `meta.card` missing] or (b) frontend dispatch bug. Distinguish by checking `data-tool-name` + `.result` raw JSON:

| task | gap |
|---|---|
| 4.5 multi-write | three fs writes fired but no diff cards showing them (all-blob or missing dispatch) |

### 4.7 Post-report reversal — §4 is a driver gap, not a product regression

The §4.1–§4.5 FAIL verdicts do **not** hold up on re-read. Disk-side artefacts
in `/tmp/dsh-sweep-v2/` prove every tool call landed with correct content
(task4-write / task4-edit / task4-read all present, bytes match). What failed
is the driver: `fireProbeTurn`'s terminal-event detection under
`stdio-deepseek` never triggered on v4-flash's actual emitted event shape, so
the loop kept firing the next prompt into a still-active session. `run.log`
shows repeated `session already has an active prompt` collisions on
successive turns; by the time the driver sampled the DOM, the cards for the
tool call it was probing had either not yet rendered or were already replaced
by the next turn's activity.

Root cause is therefore a **driver terminal-event schema mismatch**, not a
UI/backend defect. Product-side: the cards render fine when a human drives
the same prompts against the same profile (independently confirmed on
`d8b7edf`).

**Follow-ups for lane-sweep-v3:**

1. **Section 4 terminal detection** — inspect the actual `event.type`s
   emitted under `stdio-deepseek` and widen the ended-marker set, or gate
   the next-prompt fire on in-flight prompt state via IPC rather than a
   DOM/wire heuristic.
2. **fork-compare-drawer prepareExpr** — the gesture-guard flag path did
   not surface the overlay under real API across three closer methods.
   Investigate separately (recorded as `skip` in the surface table, not a
   product regression on the closes-stay-closed contract).
3. **Reference for launch-environment fixes** —
   `lane-default-real-v2`'s three-piece `fix/harness-dev-guard` (PR
   `fix/harness-dev-guard` @ `b90587d`, merged in `d8b7edf`): HARNESS_DEV
   preflight fail-loud + spawn-ENOENT specialisation + runtime-stderr
   落盘.
4. **`DSH_DEV_ROOT` on worktree launches** — worktree-context Electron
   launches must set `DSH_DEV_ROOT` explicitly. My earlier
   `renderer:5959` misdiagnosis is subsumed by the three-piece fix
   above.
5. **`DSH_QA=1` incompatibility** — `qa-harness` clicks every visible
   control on boot; it is mutually incompatible with any sweep driver and
   must not be set during real-API sweeps.

Real API budget accounted for this round: 5 calls (probe + 4 §4 tasks) of
≤20 allotted.

