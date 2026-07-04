# RFC: Pre-tool input rewrite — a consistent design (proposed)

Status: proposed (2026-06-30)

<!-- XXX: legacy ADR/RFC body format, not yet normalized to a unified RFC template. -->

## Context

The [interception-seams RFC](../../implemented/feature/2026-06-30-interception-seams.md) added `tools/pre-execute` returning a `PreToolDecision` (allow/deny/ask) — but deliberately NOT input rewrite (a hook changing a tool call's `arguments` before it runs). Claude Code's `PreToolUse` hook offers an `updatedInput`, so a faithful CC bridge wants the same. This RFC designs that, separately, because doing it consistently is a real problem — not a field to bolt onto the allow decision.

## The problem: three readers of pre-execution arguments

In the loop, a tool call's arguments are committed to the log and read by live consumers BEFORE the tool executes:

1. **`assistant/message`** is appended before tool dispatch — it is the model-history source `deriveMessages()` replays, so it carries the tool-call arguments the model itself emitted.
2. **`tool/call`** is the durable AUDIT record, appended before `ctx.tools.execute()`.
3. **Live presentation reads `tool/call.arguments`**: the ACP bridge remembers them and passes them to `presentResult`; `dsh-tool-bash` derives the card title, the rawInput, the cwd, and the terminal-vs-background treatment from them.

So an "input rewrite" that changes ONLY what executes would make the UI show one command while another RAN, and render result state against the wrong arguments — a real inconsistency, not a documentable gap. (The existing low-level capability to mutate `exec.arguments` in a listener has exactly this latent inconsistency; it is unadvertised precisely because of this — yet not unused: a tool-bash integration test rewrites a scripted call's arguments through it (`packages/bash/tool-bash/tests/integration.spec.ts`), so this design must either sanction that path with the consistency unit below or seal it — `readonly` arguments at the seam, with the test shim moved onto a behavior-level helper.)

## Proposed design (sketch — to validate against the code when built)

Treat input rewrite as a consistency unit: when a `pre-execute` hook supplies `updatedInput`, the rewrite must be reflected in ALL three readers, atomically, before execution:

- The `tool/call` audit event records the REWRITTEN arguments (with the original retained in a sidecar field for the audit trail — a hook changed the call, and both the original and the effective arguments are facts worth keeping).
- The `assistant/message` in derived history must agree with what executed — options to evaluate: rewrite the assistant message's tool-call block in place (changes what the model "sees it said"), or record a separate correction the next request carries. The CC model is that the model sees the rewrite took effect.
- Presentation (`presentCall`/`presentResult`) reads the rewritten arguments, so the UI shows what actually ran.

The shape would extend `PreToolDecision` with an allow-variant `arguments` (or a dedicated `{kind:'rewrite', arguments}`), and the loop would thread the rewrite through the three readers above rather than only into `ctx.tools.execute()`.

## Why not now

The interception-seams RFC notes input rewrite "fought the code across two review rounds" — the signal AGENTS.md names for an over-reaching change. Shipping allow/deny/ask first keeps the seam honest (no advertised contract that silently desyncs the UI), and a CC/Codex bridge that receives an `updatedInput` logs it and surfaces a faithful-but-degraded warning (like `ask`→deny) until this lands. This RFC is the home for the consistent design; `TODO(pre-tool-input-rewrite)` in the loop's pre-execute call site anchors it.

## Open questions

- Does rewriting the `assistant/message` tool-call block corrupt any provider's expectation on replay, or is a separate correction safer?
- Should the original arguments be preserved on the `tool/call` event (audit) and, if so, under what field?
- How does this interact with a future permission `ask` flow (a user approving a rewritten call)?
