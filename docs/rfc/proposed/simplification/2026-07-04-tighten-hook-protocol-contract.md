# RFC: Tighten the hook-protocol contract — the `native` dialect, `suppressOutput`, and lib-owned `hook/result` semantics

Status: proposed

## Problem

Three pieces of the `dsh-hook-protocol` contract miss the discipline the [subagent-observe-enrich RFC](../../implemented/feature/2026-06-30-subagent-observe-enrich.md) records — it dropped an `agentType` lifecycle field for lacking a consumer, and these fail the same test:

1. **`HookDialect`'s `'native'` variant** (`packages/hooks/hook-protocol/src/types.ts`) has zero producers — the bridges stamp `'claude'` and `'codex'`; the only `'native'` constructor anywhere is the lib's own unit test. The field's own JSDoc defines `dialect` as "the bridge that ran it", and native is not a bridge: the [interception-seams RFC](../../implemented/feature/2026-06-30-interception-seams.md) records that native hooks are not a package and that "a native plugin can already use the typed Decisions" without the durable hook log, and the flagship native-plugin worked example asserts exactly that (no `hook/*` events at all).
2. **`HookOutput.suppressOutput`** (same file) is parsed by the codec and discarded on every path: no bridge branch, no merge fold, no warn, no deferred-list row — uniquely among its parsed-but-unhonored siblings, each of which carries a stated deferral (`updatedInput` → a logged warn plus the [pre-tool-input-rewrite proposal](../feature/2026-06-30-pre-tool-input-rewrite.md); `systemMessage` → a logged warn plus a README deferred row; `continue`/`stopReason` → a `TODO(hook-continue-false)` anchor plus the `'stop'` decision record). Structurally there is nothing to suppress: hook stdout never enters any transcript (context flows only via `additionalContext`; the log records only `decision`/`stderrSummary`), so a hook author setting `suppressOutput: true` gets silent nothing with no warn.
3. **The `hook/result` semantics live in the bridges, twice, not in the lib that owns the event.** `summarize()` — the 500-character stderr truncation rule — is byte-identical in `packages/hooks/hooks-claude/src/index.ts` and `packages/hooks/hooks-codex/src/index.ts`, and so is the decision-string rule `output.decision ?? (output.continue === false ? 'stop' : 'pass')`; yet `dsh-hook-protocol` declares `hook/result`, documents `stderrSummary` as "truncated" without owning the truncation, and documents the decision values without owning the mapping. If one bridge drifts (a different cap, a different fallback), the shared durable event's semantics fork silently.

## Proposal

Narrow `HookDialect` to `'claude' | 'codex'` and fix its JSDoc; retarget the lib's one `'native'` test. Drop `suppressOutput` from `HookOutput`, the codec's parse lines, its codec-test assertions, and the parsed-superset lists in the lib README and [hook-protocol-lib RFC](../../implemented/feature/2026-06-30-hook-protocol-lib.md) (amended per [implemented/AGENTS.md](../../implemented/AGENTS.md)). Move the `hook/result` semantics into the lib: `appendHookResult` (or a helper it exposes) derives `stderrSummary` and the decision string from the `HookOutput` + exit outcome, and both bridges delete their private copies. Rider: un-export `BLOCKING_EXIT_CODE` (zero importers; even the codec tests spell the literal `2`).

## Why not keep them?

The [hook-protocol-lib RFC](../../implemented/feature/2026-06-30-hook-protocol-lib.md) deliberately records "parses the full CC superset" — the strongest counterargument is that this proposal re-litigates decisions that RFC records. But parsing a field whose value can never influence anything is not protocol faithfulness, it is a reader trap; and a dialect variant that the design's own thesis says will never be stamped is vocabulary without an interpreter — the bar the [subagent-observe-enrich RFC](../../implemented/feature/2026-06-30-subagent-observe-enrich.md)'s `agentType` drop records. Both return trivially with their first real producer (a transcript surface that has hook stdout to suppress; a native-provenance feature that logs hook events). On item 3, the lib RFC chose per-bridge explicitness over a parameterized engine — but that choice governed payload construction and Decision mapping; the semantics of the SHARED durable event are precisely the "primitives where duplication would actually be dangerous" that the same RFC assigns to the lib.

## Acceptance criteria

- `HookDialect` is two-valued; `rg "'native'"` in the hooks packages returns only this RFC's amended references.
- `suppressOutput` appears nowhere in source, tests, or parsed-field doc lists.
- One definition each of the truncation rule and the decision-string rule, in `dsh-hook-protocol`, exercised by both bridges' suites; the hook-matrix snapshot goldens are byte-identical.

## Risks

All three changes are invisible on the wire and in the goldens (`dialect` values emitted in practice are `claude`/`codex`; `suppressOutput` influences nothing; the folded semantics are the same rules). The cost is churn in `dsh-hook-protocol` and both bridges — cheap under the pre-release stance, and cheaper than letting two copies of a durable event's semantics age apart.
