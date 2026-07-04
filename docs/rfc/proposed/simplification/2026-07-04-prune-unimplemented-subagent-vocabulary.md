# RFC: Prune the unimplemented subagent seam vocabulary

Status: proposed

## Problem

The [subagent seam](../../implemented/feature/2026-06-21-subagent-capability-seam.md) shipped a two-tier capability design: start-time capability flags checked by the service, and optional runtime methods on `SubagentRun`. Three start-time features and both optional runtime methods have zero implementations and zero callers:

- **`outputSchema`/`structured` and `toolFilter`** (`SubagentCapabilities`, `SubagentStartRequest`, `SubagentResult` in `packages/subagent/subagent/src/types.ts`): every real provider declares `outputSchema: false, toolFilter: false` (`packages/subagent/subagent-spawn/src/index.ts`, `packages/subagent/subagent-fork/src/index.ts`, `packages/subagent/subagent-acp/src/index.ts`); the sole production `ctx.subagents.start` caller (`packages/subagent/tool-subagent/src/index.ts`) builds `{ prompt, parent, signal?, agentOptions? }` and structurally cannot set either; `structured` is produced only by the test mock (`packages/support/subagent-mock`) for its own spec. The service's capability check carries two assert rows whose only exercisers are the rejection tests.
- **`SubagentRun.sendMessage` / `SubagentRun.resume`** (same file): implemented by NO provider — not even the mock; the spawn spec asserts their *absence*.

The only reason `dsh-subagent` depends on `dsh-tools` at all is `outputSchema`'s `SchemaSpec` type. Three subsequent subagent workstreams (per-session snapshot replay, the fork seed boundary, the ACP backend) landed around this surface without growing a single consumer.

## Proposal

Remove `outputSchema`/`structured`, `toolFilter`, `sendMessage`, and `resume` from the seam; shrink `SubagentCapabilities` to `{ depthLimit }`; drop the two capability-assert rows, the all-false flags on the three providers, the mock's structured branch and its `capabilities`/`structured` config knobs, and the tests that exist to pin the removed surface (the two rejection rows, the spawn absence test, the mock structured specs). Drop the `dsh-tools` peer/dev dependency from `packages/subagent/subagent/package.json`. Update the [subagent.md](../../../core-data-structures/subagent.md) pastes and the type-equiv manifest, and the README rows in `packages/subagent/subagent`, `packages/subagent/subagent-spawn`, `packages/subagent/subagent-fork`, and `packages/support/subagent-mock`. The implementing PR amends the seam RFC's capability catalog per [implemented/AGENTS.md](../../implemented/AGENTS.md).

**Keep** `depthLimit`/`maxDepth` and the capability-check mechanism itself: the in-process backend genuinely enforces the cap (`SubagentDepthError` in `packages/subagent/subagent-inprocess/src/index.ts`), recursion is the seam RFC's named risk, and one live capability row keeps the two-tier design demonstrated rather than merely remembered.

This is the seam-vocabulary echo of [prune dead methods from the persistence seam](../../implemented/simplification/2026-06-20-prune-dead-seam-methods.md): members every implementation must declare for nobody — weaker even, since here zero implementations exist.

## Why not keep it?

The two-kinds-of-capability design is the seam RFC's headline, and re-adding `outputSchema` later touches several files. But the design survives with `depthLimit` as its live example and the RFCs as its record, and the seam RFC itself concedes the shipped `toolFilter` shape is wrong (real enforcement needs a `tools/pre-execute` deny in the child's context, not schema filtering) — that deny primitive exists on the interception seams, so re-adding against a real implementing provider will pin a better contract than the current speculative one.

## Acceptance criteria

- The removed spellings appear only in this RFC and the amended seam RFCs; `SubagentCapabilities` is `{ depthLimit: boolean }`; the `dsh-tools` dependency edge is gone (`hygiene` green).
- Depth-enforcement tests are unchanged and green.

## Risks

The subagent lifecycle events carry `lastAssistantMessage` on the end payload (the [subagent-observe-enrich RFC](../../implemented/feature/2026-06-30-subagent-observe-enrich.md)) — that enrichment lives in the service module, not the seam vocabulary this RFC shrinks, and the same RFC records dropping an `agentType` sibling for lacking a consumer: the judgment this RFC extends. The CC hooks bridge, the first outside consumer of those lifecycle events, reads only the event payloads and touches none of the surface removed here; the observe-enrich RFC's deferred control-flow redesign names implementing `resume` as its own future work — exactly the re-add trigger this RFC's pattern anticipates. Worth recording while here: nothing production sets `maxDepth` today (`tool-subagent` exposes no knob for it), so in-process recursion is uncapped — wiring the depth machinery this RFC keeps is a small feature gap, and an argument for keeping it, not for cutting it.
