# RFC: Drop unconsumed registry events

Status: proposed

## Problem

Four registry notifications are produced but have no production listener. The generated producer/consumer matrix and exact event-name searches find only declarations, emit sites, invariant metadata, tests, generated catalogs, and prose for `tools/change`, `system-prompt/change`, `skill/provider-added`, and `skill/provider-removed`.

No shipped path uses these signals for invalidation: request assembly deliberately reruns for every step, tool/system-prompt membership may be agent-scoped, and skill discovery reads providers on demand. The payloadless tool/system-prompt notices are also insufficient for a scoped observer because a change may be local to one agent but the event cannot identify that scope.

Earlier registry work retained tool/system-prompt notifications as low-cost hooks for a hypothetical live UI even while the equivalent LLM and web notifications were removed. The new evidence is that no owner has appeared, per-step assembly needs no signal, and scope-local membership has made the old payload insufficient for that hypothetical owner. This proposal does not include `subagent/provider-added`/`removed`, which `tool-subagent` consumes to tolerate concurrent sibling-plugin loading.

## Proposal

Delete the four declarations and every emit path, rollback-order branch, invariant-table entry, test, and generated catalog/matrix row that exists only for them. Remove the corresponding registry README/JSDoc contract. Where tests used an event to observe cleanup, assert public lookup or assembled output instead.

Amend the [agent-scope RFC](../../implemented/architecture/2026-07-08-agent-scope-contexts.md) and reconstructable-request documentation so current behavior has one home: request inputs are recomputed at the request boundary, not maintained by invalidation signals.

## Alternatives considered

**Keep cheap notifications for future plugins.** An external plugin could subscribe later, and provider lifecycle signals can solve sibling-load races. The subagent event demonstrates the bar: it has a real concurrent loader consumer and a payload tailored to that job. These four have neither; a future consumer should introduce the scoped identity and timing it demonstrably needs.

## Acceptance criteria

- The generated event matrix contains no row or registry-subject inventory entry for the four notifications.
- Tool schema assembly, system-prompt assembly, skill discovery, ordinary effect rollback/disposal, and registry lookup cleanup behave unchanged; listener-triggered rollback disappears with the events.
- The real subagent provider lifecycle consumer remains covered.
- Typecheck, coverage, snapshots, doc-sync, module-graph verification, build, and hygiene pass.

## Risks

This deliberately removes pre-release plugin observation points. A future live registry UI would need a new scoped snapshot/change contract instead of subscribing to payloadless global notifications.
