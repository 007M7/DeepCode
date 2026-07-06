# RFC: Discover package inventories instead of maintaining static lists

Status: proposed

## Problem

Package and gate inventories are repeated by hand. The [package cookbook](../../../cookbook/adding-a-package.md) tells authors to update several files. The [package README](../../../../packages/README.md) carries a hand-written dependency graph. [CI](../../../../.github/workflows/ci.yml) and [development docs](../../../development.md) can drift from the actual `doc-sync` subcommands when new gates are added. `tsconfig.build.json` and the root `tsconfig.json` each hand-list every package as explicit project `references` — two identical sets that grow in lockstep, so a single generator can emit both — and `tsconfig.base.json`'s paths map hand-lists the per-group glob fan-out. `knip.json` restates a per-package `entry` stanza for each package that gains an `*.e2e.ts` suite — byte-identical overrides that exist only because the shared `packages/*/*` stanza omits the e2e glob (an entry glob matching no files is inert, so the default stanza could carry it for every package). The ACP snapshot suite's scenario table (`examples/acp-agent/tests/acp.snapshot.ts`) hand-maintains a `childSessions` count per scenario that duplicates the number of `session.<n>.jsonl` fixture siblings on disk. These lists are small today, but every new package or scenario class creates another manual synchronization point.

The [package hierarchy](../../implemented/architecture/2026-06-20-package-hierarchy.md) already removed several of these by hand: `scripts/publint-all.ts` now derives its list from the `packages/<group>/<pkg>` layout, and the two `tsconfig` `paths` maps collapsed to one `@deepseek-ai/dsh-*` wildcard. What remains is the inventory that cannot be globbed away — chiefly `tsconfig.build.json`'s project `references`, which TypeScript requires as an explicit array (no wildcard form).

Static lists are appropriate when they encode policy; they are needless friction when they duplicate manifest data or layout facts that already exist in `package.json`, workspace globs, or the package hierarchy.

## Proposal

Make the remaining package/gate inventories discoverable. A single canonical source — the `packages/<group>/<pkg>` hierarchy plus package manifests — should drive `tsconfig.build.json`'s `references`, the module graph, and any other full-package list, with a generate-and-verify step (the existing `gen-module-graph` / `gen-cordis-catalog` pattern: a generator writes the artifact, a `--check` mode in `hygiene`/`doc-sync` fails on a stale committed copy). Module graph generation already reads package manifests. `doc-sync` should be the one command that defines and prints its sub-gates, with docs linking to that command rather than restating a second list.

The hierarchy does not need to encode every fact about a package, but it should encode the broad maintenance policy: core/product packages, integrations, capability seams, and support/test/example packages should not all require a hand-maintained exception list before scripts can tell them apart.

Two of the cataloged items need no generator at all: folding the e2e entry glob into knip's default stanza deletes the per-package restatements outright, and `childSessions` can be discovered from each scenario's fixture directory, leaving the scenario table to declare only policy (`recorded`, `hasModelTurn`, `comparesLog`) — and even those track fixture-derivable facts today (`comparesLog` ⟺ the committed log has entries beyond its header line; `recorded` ⟺ `hasModelTurn` with no `replay.override.json` sibling), so each new scenario class keeps adding knobs the fixture directory already answers.

## Acceptance criteria

- `tsconfig.build.json` project `references` are generated from the hierarchy (a generator emits them; a `--check` gate fails when the committed copy is stale), rather than hand-maintained.
- Adding a package does not require editing a static package list for any gate.
- Docs describe the source of truth rather than repeating generated inventories.
- CI invokes the aggregate commands and lets those commands own their sub-gate lists.
- `knip.json` carries a per-package override only where it encodes real information (an extra entry file, an ignored dependency), never a restatement of the default stanza.
- Snapshot scenarios declare policy, not facts discoverable from their fixture directories.

## Risks

Discovery scripts can become too clever. The implementation should stay boring: read manifests, filter on explicit fields, print the resolved list, and fail loud. The payoff is removing manual inventory drift, not inventing a build system.

<!-- rfc-format: alternatives-not-recorded (pre-format RFC) -->
