# RFC: Pin request-header content in one snapshot scenario

Status: implemented

## Problem

Every model-driving ACP snapshot fixture (`session.jsonl`) embedded the full composed system prompt and the complete tool-schema list in its `request/header` event — roughly 8 KB on one line, per fixture. That content is identical across the suite (byte-identical tool list everywhere, including subagent children; identical prompt modulo each recording's temp cwd), so any PR touching a tool description or a system-prompt line had to update every fixture: re-record everything against the live API (churning model responses and stdout goldens along the way) or hand-edit ~35 giant header lines. The dynamic-workflows PR (#170) is the canonical example — adding one tool and one prompt paragraph rewrote every snapshot fixture in the repo, burying the behavioral diff a reviewer should be reading.

## Decision

Exactly one scenario — `text-turn`, flagged `pinsHeader` in `acp.snapshot.ts` — commits and compares the full request-header content. Every other fixture stores and compares that content as stable tokens: a `request/header` event's `header.system` becomes `"{{system}}"` and `header.tools` becomes `"{{tools}}"`, and a `request/header-delta`'s `system`/`tools` payloads likewise (a delta embeds prompt/schema fragments, so leaving it raw would reopen the churn). The scrub is a pure normalizer, `scrubRequestHeaders` in `snapshot-normalize.ts`, composed in front of `normalizeSessionLog` on BOTH sides of a non-pinning scenario's log compare and applied to the harvested logs record mode writes, so a re-record cannot smuggle the content back. Absent fields stay absent — WHETHER a header carried a prompt or tools is behavior and stays visible — and `config`/`reason` stay verbatim: a model swap SHOULD churn every fixture (it invalidates the recorded responses), while a prompt or schema edit does not (replay derives model behavior exclusively from `assistant/chunk` events and never reads header content — see `dsh-llm-replay`).

A system-prompt or tool-schema change therefore lands as exactly one committed-fixture diff — the pinned `text-turn` header line — updated by hand or by re-recording that one scenario (`pnpm run test:snapshot:record` with `-t text-turn`).

Guards in the fixture meta-tests make the split self-enforcing: every non-pinning `session*.jsonl` must be a fixed point of `scrubRequestHeaders` (unscrubbed content crept in — apply the scrub), the pinning scenario's fixture must NOT be one (the pin lost its content), and exactly one scenario must pin.

Today one pin covers the whole suite because every fixture — parent, spawn child, fork child — records the identical tool list and the identical prompt modulo cwd. If header composition ever becomes session-dependent (a restricted subagent toolset, say), the flag extends to one pinning scenario per distinct header shape.

## Alternatives considered

- **Re-record or hand-edit every fixture per change** — the status quo; the churn this RFC removes.
- **Scrub at compare time only, keeping fixtures raw** — the compares go green without fixture edits, but every committed fixture then carries a permanently stale copy of the prompt and schemas: dead weight that misleads readers and still rewrites wholesale on the next re-record. Storing the tokens keeps the fixture honest about what it does and does not pin.
- **Scrub everywhere, pin nowhere** — loses the only end-to-end record of the composed header as actually sent (prompt assembly, registered-tool order, full schemas). The generated tool catalog documents each tool in isolation; only a real fixture pins the composed set.
- **Slim the session log itself (log a content digest, store the header elsewhere)** — violates the reconstructability contract: the product log must reproduce each request bit-for-bit ([reconstructable-requests RFC](../architecture/2026-07-05-reconstructable-requests.md)). Header bulk is a test-artifact concern, solved in test normalization; the live log is untouched.

## Verification

All 37 snapshot scenarios replay green with the scrubbed fixtures (the committed fixtures were rewritten once through `scrubRequestHeaders` itself; `text-turn` untouched). The fixed-point, pin-retains-content, and exactly-one-pin guards run inside the suite, and `scrubRequestHeaders` has unit coverage for both header event types, absent-field preservation, config/reason retention, byte-for-byte pass-through of other lines, and idempotence.

## Consequences

A tool-description or system-prompt change churns one committed fixture line instead of every fixture in the suite, so snapshot diffs read as behavior again, and ~270 KB of duplicated header bytes leave the repo. The cost: fixtures no longer show per-scenario header content, so a non-uniform header would be invisible outside the pinned scenario — accepted while composition is provably suite-uniform (the recording is made by one `cordis.yml` for all scenarios), and revisited with additional pins if that ever changes.
