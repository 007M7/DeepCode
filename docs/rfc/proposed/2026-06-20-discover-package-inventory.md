# RFC: Discover package inventories instead of maintaining static lists

Status: proposed

## Problem

Package and gate inventories are repeated by hand. [scripts/publint-all.ts](../../../scripts/publint-all.ts) has a static list of publishable packages. The [package cookbook](../../cookbook/adding-a-package.md) tells authors to update several files. The [package README](../../../packages/README.md) carries a hand-written dependency graph. [CI](../../../.github/workflows/ci.yml) and [development docs](../../development.md) can drift from the actual `doc-sync` subcommands when new gates are added. These lists are small today, but every new package or gate creates another manual synchronization point.

Static lists are appropriate when they encode policy; they are needless friction when they duplicate manifest data or layout facts that already exist in `package.json`, workspace globs, or the package hierarchy.

## Proposal

Make package/gate inventories discoverable. Publishability should come from the deliberate [package hierarchy](2026-06-20-package-hierarchy.md) plus package manifests, not from a static array in a script or the npm `private` flag. Module graph generation should read package manifests. `doc-sync` should be the one command that defines and prints its sub-gates, with docs linking to that command rather than restating a second list.

The hierarchy does not need to encode every fact about a package, but it should encode the broad maintenance policy: core/product packages, integrations, capability seams, and support/test/example packages should not all require a hand-maintained exception list before scripts can tell them apart.

## Acceptance criteria

- `publint-all` discovers publishable packages from the hierarchy plus manifests instead of a hard-coded array.
- Adding a package does not require editing a static package list for every gate.
- Docs describe the source of truth rather than repeating generated inventories.
- CI invokes the aggregate commands and lets those commands own their sub-gate lists.

## What we give up

Discovery scripts can become too clever. The implementation should stay boring: read manifests, filter on explicit fields, print the resolved list, and fail loud. The payoff is removing manual inventory drift, not inventing a build system.
