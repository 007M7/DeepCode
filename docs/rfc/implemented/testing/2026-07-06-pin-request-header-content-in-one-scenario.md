# RFC: Pin request-header content in one snapshot scenario

Status: implemented

## Problem

An ACP snapshot suite needs to prove the exact composed system prompt and tool-schema list sent in each `request/header`, but duplicating that content inside every `session.jsonl` makes a prompt or schema edit rewrite dozens of giant one-line JSON records. Keeping one raw header avoids the duplication but still makes prompt review poor: prose is JSON-escaped onto one line and mixed with thousands of characters of tool schemas.

## Decision

Exactly one scenario per header-composition class is flagged `pinsHeader`. Its directory splits the pin by review format: `system-prompt.golden.md` contains the normalized composed prompt as ordinary Markdown, while `session.jsonl` keeps the full tool-schema list, config, and reason but stores `header.system` as `"{{system}}"`. Every other JSONL stores both the system prompt and tool list as `"{{system}}"` / `"{{tools}}"`. The pin mechanics live in [`dsh-acp-snapshot`](../../../../packages/support/acp-snapshot/README.md), whose suite factory enforces one pin per class.

The pure `scrubSystemPrompts` normalizer applies to every stored session fixture and tokenizes both an initial header's prompt and a header delta's inserted prompt lines. `scrubRequestHeaders` additionally tokenizes tool schemas and session-prefix content for non-pinning scenarios while retaining structural facts: system-delta positions and arity, added/removed/changed tool names, prefix message count, field presence, config, and reason. Record and refresh write-back apply the appropriate scrub before writing JSONL and regenerate the Markdown prompt from the normalized live header, so neither path can reintroduce prompt text into JSONL or leave the readable snapshot stale.

Guards make the split self-enforcing. On disk, every `session*.jsonl` is a fixed point of `scrubSystemPrompts`, only non-pinning fixtures are fixed points of the full header scrub, `system-prompt.golden.md` exists exactly beside pinning fixtures, and each class has one pin. Live, every `request/header` produced by a parent, spawn child, fork child, initial request, or resume must match both halves of its class's pin after volatile-value normalization. A header without a string prompt or any `request/header-delta` fails loud because the two static pin artifacts cannot represent it.

One pin covers the whole suite because every session — parent, spawn child, fork child — composes the identical tool list and the identical prompt modulo cwd, and the uniformity guard fails the suite the moment that stops holding. If header composition ever becomes session-dependent by design (a restricted subagent toolset, say), the divergent shape gets its own pinning scenario.

## Alternatives considered

- **Re-record or hand-edit every fixture per change** — preserves exact headers but buries behavioral diffs under duplicated prompt and schema content.
- **Scrub at compare time only, keeping fixtures raw** — lets compares pass while committed fixtures retain stale duplicate content and rewrite wholesale on the next recording. Stored tokens state honestly what each JSONL does not pin.
- **Scrub everywhere, pin nowhere** — loses the only end-to-end record of the composed header as actually sent (prompt assembly, registered-tool order, full schemas). The generated tool catalog documents each tool in isolation; only a real fixture pins the composed set.
- **Keep the one full pin entirely in JSONL** — removes suite-wide duplication but leaves system-prompt changes as an escaped one-line diff entangled with the tool list. Markdown gives prompt prose its natural review format without weakening the header assertion.
- **Slim the session log itself (log a content digest, store the header elsewhere)** — violates the reconstructability contract: the product log must reproduce each request bit-for-bit ([reconstructable-requests RFC](../architecture/2026-07-05-reconstructable-requests.md)). Header bulk is a test-artifact concern, solved in test normalization; the live log is untouched.

## Verification

The suite replays every scenario against the split pins. Unit coverage exercises both scrub levels, Markdown formatting, record/refresh regeneration, normalized prompt extraction, fixed-point enforcement, required-file symmetry, header uniformity, and delta rejection.

## Consequences

A system-prompt change produces a normal line-oriented Markdown diff in one file per affected composition class; a tool-description change produces one pinned JSONL line per class; ordinary behavioral fixtures remain untouched. Session fixtures display tokens for omitted content, and the live uniformity guard makes each split pin authoritative for every session in its class. The pinning scenario carries one extra generated artifact whose terminal newline is canonicalized for repository hygiene.
