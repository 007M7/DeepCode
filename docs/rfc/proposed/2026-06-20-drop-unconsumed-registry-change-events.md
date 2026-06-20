# RFC: Drop the unconsumed registry `*/change` notification events

Status: proposed

## Problem

Three registries each emit a "something changed" notification event that no production listener subscribes to:

- `tools/change` — emitted by `ToolRegistry.register()` on register and disposal ([packages/tools/src/index.ts:302-304](../../../packages/tools/src/index.ts)).
- `system-prompt/change` — emitted by `SystemPrompt.section()` and `.tools()` ([packages/system-prompt/src/index.ts:86-110](../../../packages/system-prompt/src/index.ts)).
- `llm/adapter-change` — emitted by `LlmService.registerAdapter()` ([packages/llm/src/index.ts:98-100](../../../packages/llm/src/index.ts)).

Grepping the three event names across `packages/*/src` and `examples/*/src` finds only the emit sites and their declarations — zero `ctx.on('.../change')` listeners in production. The only subscribers are each package's own spec file, and they subscribe purely to test that the emit fires. They are listed in the event taxonomy table ([docs/architecture.md](../../../docs/architecture.md)) as `emit` events, but nothing reacts to them.

These events are speculative generality for a hypothetical reactive consumer (a UI that live-refreshes its tool palette, say) that does not exist. That alone would be a mild [drop-the-dead-summary](../implemented/2026-06-19-drop-mutable-session-summary.md)-style cut. What makes it worth an RFC is the machinery the events drag along: to emit `.../change` safely, each registry orders its generator effect so the rollback disposer is `yield`ed before the change-emit, specifically so a throwing change-listener unwinds the mutation instead of leaking a registry entry. Every one of the three carries a multi-line comment justifying this ordering, plus a dedicated "rollback when a change listener throws" test. That is a non-trivial correctness burden guarding a failure mode that only the tests' own injected listeners can trigger, because there are no real listeners.

## Proposal

Remove the three `*/change` events and the defensive machinery that exists only to make them safe:

- Delete the `tools/change`, `system-prompt/change`, `llm/adapter-change` declarations from each package's `interface Events`.
- Delete the `ctx.emit('.../change')` calls.
- Simplify each `ctx.effect` generator: the mutation and its rollback disposer remain (HMR/disposal still need them), but the "yield rollback before the emit so a throwing listener rolls back" ordering comment and any emit-after-yield collapse to a plain `set`/`push` plus a `yield () => delete`/`splice`. No behavior an external observer can see changes, because nothing observes the events.
- Remove the "Emits `.../change` on register/unregister" sentence from the surviving registration-method JSDocs — these sit on methods that stay, so they go stale rather than vanish with the deleted code: `LlmService.registerAdapter` ([packages/llm/src/index.ts](../../../packages/llm/src/index.ts)), `ToolRegistry.register` ([packages/tools/src/index.ts](../../../packages/tools/src/index.ts)), and both `SystemPrompt.section` and `SystemPrompt.tools` ([packages/system-prompt/src/index.ts](../../../packages/system-prompt/src/index.ts)).
- Delete or rewrite the tests that exist to exercise the events. The change-listener-rollback tests are deleted outright (the rollback behavior goes with the event). The positive emission-subscriber tests are handled case by case: `system-prompt/tests/system-prompt.spec.ts`'s "emits system-prompt/change ..." is deleted (its disposal coverage is duplicated by the separate "cleans up tool providers on fiber dispose" / "removes section when returned disposer is called directly" tests), but `llm/tests/service.spec.ts`'s "disposes adapter registration on adapter-change event emission" is the only test that calls the `registerAdapter()` returned disposer and asserts the adapter is removed (the HMR test at "unregisters adapters when the owning fiber is disposed" covers fiber disposal, a different path) — so it is rewritten to drop the event subscription while keeping the returned-disposer assertion, not deleted. Per AGENTS.md "tests document behavior, not golden truth".
- Update the event taxonomy table in [docs/architecture.md](../../../docs/architecture.md) (remove the three rows) and re-run `pnpm run verify-event-taxonomy`, which mechanically checks the table against source. Also remove the per-package README event rows that list them: [packages/tools/README.md](../../../packages/tools/README.md) (`tools/change`), [packages/system-prompt/README.md](../../../packages/system-prompt/README.md) (`system-prompt/change`), and [packages/llm/README.md](../../../packages/llm/README.md) (`llm/adapter-change`). The [doc-sync-enforcement RFC](../implemented/2026-06-11-doc-sync-enforcement.md), whose `verify-event-taxonomy` description names these three as the events that surfaced when the check landed, is reworded so its example does not point at removed events.

## Why not keep them as a "registries announce changes" convention?

That is the honest counter-argument: a microkernel where every registry announces its mutations is a clean, uniform reactive substrate, and a future live UI would want exactly this. Three considerations push the other way:

1. **The harness already has a finer-grained feed for the one realistic consumer.** A UI live-renders from `session/event` and `agent/*`, not from registry mutations — tools/sections/adapters are registered at plugin-load time and effectively static during a session. The `.../change` events fire almost exclusively during boot and HMR, when nothing is watching.
2. **Pre-release stance.** [AGENTS.md](../../../AGENTS.md) says optimize for the correct foundation, not a speculative future; add the seam when a real consumer needs it. Re-adding an emit is one line; the cost today is the standing rollback-ordering burden on three hot registration paths.
3. **The events are not free — they shape the registration code.** Keeping them means keeping the throwing-change-listener invariant and its tests forever, for a listener that cannot exist until someone adds one.

If a reactive consumer is later built, it should be reintroduced deliberately, as one coherent decision about which registries announce what (and possibly a single `registry/change` shape), not as three independently-grown emits nothing reads.

## Acceptance criteria

- The three events and their emits are gone; `pnpm run verify-event-taxonomy` passes against the updated table.
- HMR-safety tests still pass: disposing a contributing fiber still removes the tool/section/adapter (the rollback disposer is retained; only the change-emit and its throwing-listener guard are removed).
- `pnpm run test:coverage` stays 100% per-file.
- No production code path changes observable behavior (verified by unchanged ACP snapshot goldens and the echo-agent smoke test).

## Risks

- **Removing a documented emit event is a public-surface change.** It is in the taxonomy table, so it reads as deliberate API. But "declared and emitted" is not "consumed" — the same distinction that justified dropping the mutable summary. The taxonomy table is updated in the same change, so the docs do not drift.
- **A registry that genuinely wants change-notification later pays a small reintroduction cost.** Judged acceptable per the pre-release stance; the reintroduction is mechanical.

This is a small-to-medium cut across three packages and, more valuably, it retires a standing correctness invariant that guards a consumer that does not exist.
