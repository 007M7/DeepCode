# RFC: Drop unconsumed skill provider events

Status: proposed

## Problem

Two skill-registry notifications are produced but have no production listener. The generated producer/consumer matrix and exact event-name searches find only declarations, emit sites, tests, generated catalogs, and prose for `skill/provider-added` and `skill/provider-removed`.

Skill discovery reads the current provider map on demand, provider registration synchronously clears completed catalogs, and the post-await revision check prevents stale discovery from entering the cache. No sibling plugin waits for a skill provider through these events, unlike the live `subagent/provider-added` consumer that tolerates concurrent sibling loading.

`tools/change` and `system-prompt/change` are explicitly outside this proposal. Existing simplification decisions retain them as intentional observation points for live tool and prompt UIs, and self-referential mounted plugins already use `tools/change`. This proposal also leaves `subagent/provider-added`/`removed` unchanged because `tool-subagent` has a production lifecycle consumer.

## Proposal

Delete the two skill-provider declarations and every emit path, rollback-order branch, test, and generated catalog/matrix row that exists only for them. Remove the corresponding skill-registry README/JSDoc contract. Where tests used an event to observe cleanup, assert provider lookup or collected output instead.

Amend the skill-system RFC and package documentation so provider registration is described as direct effect-owned state with cache invalidation, not as a lifecycle notification contract.

## Alternatives considered

**Keep skill-provider notifications for future plugins.** A third-party plugin could observe provider availability, but direct provider registration and on-demand lookup are the extension contract; no current consumer needs a push signal. If a future sibling-load race appears, it can introduce a notification with the identity and readiness semantics that consumer requires, as the subagent registry did.

## Acceptance criteria

- The generated event matrix contains no row for `skill/provider-added` or `skill/provider-removed`.
- Skill discovery, direct runtime registration, provider effect rollback/disposal, cache invalidation, and registry lookup cleanup behave unchanged; listener-triggered rollback disappears with the events.
- `tools/change`, `system-prompt/change`, and the real subagent provider lifecycle consumer remain documented and covered.
- Typecheck, coverage, snapshots, doc-sync, module-graph verification, build, and hygiene pass.

## Risks

This removes pre-release skill-provider observation points while retaining both ways third-party plugins contribute skills: direct runtime registration and provider registration. A future consumer that needs live provider availability must add a purpose-built notification rather than relying on these generic events.
