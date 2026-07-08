# RFC: Pin request-header content in one snapshot scenario

Status: implemented

## Problem

Every model-driving ACP snapshot fixture (`session.jsonl`) embedded the full composed system prompt and the complete tool-schema list in its `request/header` event — roughly 8 KB on one line, per fixture. That content is identical across the suite (byte-identical tool list everywhere, including subagent children; identical prompt modulo each recording's temp cwd), so any change touching a tool description or a system-prompt line had to update every fixture: re-record everything against the live API (churning model responses and stdout goldens along the way) or hand-edit ~35 giant header lines. Introducing the dynamic-workflows feature — one new tool plus one prompt paragraph — rewrote every snapshot fixture in the repo, burying the behavioral diff a reviewer should be reading.

## Decision

Exactly one scenario — `text-turn`, flagged `pinsHeader` in the `acp.snapshot.ts` scenario table — commits and compares the full request-header content; the pin mechanics live in [`dsh-acp-snapshot`](../../../../packages/support/acp-snapshot/README.md), whose suite factory enforces one pin per consuming suite. Every other fixture stores and compares that content as stable tokens via the pure normalizer `scrubRequestHeaders` in that package's `normalize.ts`: a `request/header` event's `header.system` becomes `"{{system}}"` and `header.tools` becomes `"{{tools}}"`; a `request/header-delta` keeps its structural facts — the system delta's `keepStart`/`keepEnd` line positions with one `{{system}}` token per inserted line, the tools delta's added/removed/changed tool names — and tokenizes only the bulk (prompt text, schema bodies), so two different deltas still compare different. The scrub is composed in front of `normalizeSessionLog` on BOTH sides of a non-pinning scenario's log compare and applied to the harvested logs record mode writes, so a re-record cannot smuggle the content back. Absent fields stay absent — WHETHER a header carried a prompt or tools is behavior and stays visible — and `config`/`reason` stay verbatim: a model swap churns every fixture by design (it invalidates the recorded responses), while a prompt or schema edit churns none of them (replay derives model behavior exclusively from `assistant/chunk` events and never reads header content — see `dsh-llm-replay`).

A system-prompt or tool-schema change therefore lands as exactly one committed-fixture diff — the pinned `text-turn` header line — updated by hand or by re-recording that one scenario (`pnpm run test:snapshot:record` with `-t text-turn`).

Guards make the split self-enforcing. On disk (fixture meta-tests): every non-pinning `session*.jsonl` must be a fixed point of `scrubRequestHeaders` (unscrubbed content crept in — apply the scrub), the pinning scenario's fixture must NOT be one (the pin lost its content), and exactly one scenario must pin. Live (every non-pinning scenario run): each `request/header` the run produces — parent, spawn child, fork child, initial or resume — must equal the pinned fixture's header after both sides normalize their own volatile values, and no `request/header-delta` may appear at all (a mid-run header change diverges from the pin by construction, and its content would be invisible under the scrub), so the single-pin premise is asserted rather than assumed.

One pin covers the whole suite because every session — parent, spawn child, fork child — composes the identical tool list and the identical prompt modulo cwd, and the uniformity guard fails the suite the moment that stops holding. If header composition ever becomes session-dependent by design (a restricted subagent toolset, say), the divergent shape gets its own pinning scenario.

## Alternatives considered

- **Re-record or hand-edit every fixture per change** — the status quo; the churn this RFC removes.
- **Scrub at compare time only, keeping fixtures raw** — the compares go green without fixture edits, but every committed fixture then carries a permanently stale copy of the prompt and schemas: dead weight that misleads readers and still rewrites wholesale on the next re-record. Storing the tokens keeps the fixture honest about what it does and does not pin.
- **Scrub everywhere, pin nowhere** — loses the only end-to-end record of the composed header as actually sent (prompt assembly, registered-tool order, full schemas). The generated tool catalog documents each tool in isolation; only a real fixture pins the composed set.
- **Slim the session log itself (log a content digest, store the header elsewhere)** — violates the reconstructability contract: the product log must reproduce each request bit-for-bit ([reconstructable-requests RFC](../architecture/2026-07-05-reconstructable-requests.md)). Header bulk is a test-artifact concern, solved in test normalization; the live log is untouched.

## Verification

All 37 snapshot scenarios replay green with the scrubbed fixtures (the committed fixtures were rewritten once through `scrubRequestHeaders` itself; `text-turn` untouched). The fixed-point, pin-retains-content, exactly-one-pin, live header-uniformity, and no-unpinned-delta guards run inside the suite, and `scrubRequestHeaders` has unit coverage for both header event types, delta structure preservation (line positions, insert arity, tool names), absent-field preservation, config/reason retention, byte-for-byte pass-through of other lines, and idempotence.

## Consequences

A tool-description or system-prompt change churns one committed fixture line instead of every fixture in the suite, so snapshot diffs read as behavior again, and ~270 KB of duplicated header bytes leave the repo. The cost: non-pinning fixtures no longer display header content, so reading one shows tokens where the prompt and schemas were — the pinned `text-turn` fixture is the place to look, and the live uniformity guard guarantees it speaks for every session in the suite. A header change surfaces as a suite-wide test failure whose fix is the one pinned line, rather than as ~35 fixture rewrites.
