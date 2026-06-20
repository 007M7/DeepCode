# RFC: Classify packages by aspect metadata

Status: proposed

## Problem

The harness package tree is flat, and every package manifest is currently `private: true`. That is fine as a pre-release safety default, but it means neither paths nor npm publish flags tell scripts what role a package plays. [publint-all](../../../scripts/publint-all.ts) needs to know which packages are release-shaped, docs need to describe which packages are core product surface, and future cleanup work needs a way to distinguish support utilities from load-bearing product modules.

A single hierarchy such as product, integration, support, or testing is too coarse. Packages naturally carry overlapping facts: an LLM adapter is provider-facing and publish-shaped; `tool-bash` is a tool consumer and bash-related; `llm-replay` is an LLM adapter shape and test/snapshot support; ACP is an editor bridge and current product surface. Forcing each package into one bucket would either hide useful facts or recreate static exception lists under different names.

## Proposal

Add explicit, repo-owned package aspect metadata to each `packages/*/package.json`, using a manifest-local key such as `dsh.aspects` unless the implementing change finds an already-established repo metadata key. The metadata is a controlled vocabulary, not free-form prose.

For example:

```json
{
  "dsh": {
    "aspects": ["core", "llm", "publishable"]
  }
}
```

The initial vocabulary should stay small and useful to scripts. Expected facets include `core`, `implementation`, `consumer`, `llm`, `bash`, `fs`, `persistence`, `agent`, `acp`, `ui`, `example-support`, `test-support`, `replay`, and `publishable`. A package may declare multiple facets; no script should assume exactly one role.

`publishable` is a repo policy facet, not a mirror of npm's `private` flag. While the harness is unreleased, packages can remain `private: true` and still declare `publishable` so publish-shape gates know which manifests to check. When release policy changes, the aspect continues to describe intent while the npm flag controls whether publication is allowed.

Scripts should consume the metadata directly. `publint-all` filters on `publishable`, module graph or package inventory docs can group by domain facets, and the adding-a-package cookbook asks authors to choose aspects when creating a new package. Unknown facets should fail loudly so typoed metadata does not silently fork the taxonomy.

## Acceptance criteria

- Every `packages/*` manifest declares package aspects from a documented controlled vocabulary.
- The vocabulary explains each facet's meaning and when a new facet is appropriate.
- `publint-all` derives its package list from `publishable` metadata instead of a hard-coded array.
- Package inventory docs and module-graph grouping can read aspects without inferring intent from package names or folder paths.
- Adding a package requires choosing aspects, and CI fails if a package is missing aspect metadata or uses an unknown facet.
- No package path moves are required just to express classification.

## What we give up

Aspect metadata is less visually obvious than folders, and a package can be over-tagged if reviewers are careless. The counterweight is that metadata preserves the current package import shape while making policy facts explicit and machine-checkable. If a future package truly needs a new physical boundary, that move can still happen for architectural reasons rather than as a classification workaround.

## Related

This supersedes the rejected [product/integration/support package taxonomy](../rejected/2026-06-20-classify-support-packages.md) and supplies the package source of truth expected by [discover package inventories](2026-06-20-discover-package-inventory.md).
