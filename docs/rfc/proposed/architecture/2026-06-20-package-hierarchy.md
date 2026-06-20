# RFC: Reorganize packages into a modular hierarchy

Status: proposed

## Problem

`packages/` is flat. Core product packages, provider integrations, capability seams, example UI support, and snapshot-only replay support all sit at the same level and look equally foundational. The [package README](../../../../packages/README.md) already has a `FIXME(package-hierarchy)` noting that `ui-stdio` and `llm-replay` were extracted from examples mostly for reuse and coverage. The flat layout makes support packages appear more product-shaped than they are and forces publish/lint/doc scripts to encode intent through comments or static lists.

This is not just cosmetic. A package's location currently says little about whether it is core API, a swappable capability, an adapter integration, an example harness helper, or test infrastructure. That makes future removal harder because every top-level package looks like part of the same public surface.

## Proposal

Move packages into a deliberate hierarchy under `packages/`. The exact layout is deferred to the implementing PR, but it should group packages by modular role rather than keep every package at one flat level.

One plausible shape:

```text
packages/
  core/
    session/
    system-prompt/
    tools/
    agent/
    agent-loop/
    invariants/
  llm/
    llm/
    adapters/
      llm-deepseek/
      llm-pi-ai/
  bash/
    bash/
    bash-local/
    tool-bash/
  session-persistence/
    session-persistence/
    session-persistence-jsonl/
    session-persistence-sqlite/
  acp/
  support/
    ui-stdio/
    llm-replay/
```

The final implementation may choose different names or groupings, but it should keep the same intent: core APIs, package families such as LLM/bash/session persistence, standalone integrations such as ACP, and support/test/example packages are distinguishable from the filesystem alone. Npm package names can stay `@deepseek-ai/dsh-*`; the hierarchy is about repo structure and maintenance policy, not public package renaming.

This proposal does not delete `llm-replay` or `ui-stdio` by itself. It makes their status honest: either they graduate into product packages with documented consumers, or they live under a support/testing/example classification where release and compatibility expectations are lower.

## Acceptance criteria

- Packages move from the flat `packages/<name>/` layout into a documented modular hierarchy.
- The implementing PR chooses the exact hierarchy and updates workspace globs, TypeScript paths, package docs, generated module graphs, `cordis.yml` package paths, build scripts, and publish/lint scripts in one coordinated move.
- Scripts that publish, lint publishability, or generate package inventories use the hierarchy instead of an ad hoc static list where the hierarchy is enough to express the policy.
- Docs explain which package groups are part of the product API and which groups are support/test/example infrastructure.
- New package guidance tells authors where to place a package and discourages new one-off top-level groups.

## What we give up

The restructure churns imports, workspace globs, docs links, and package paths. That churn is acceptable pre-release if it prevents the flat layout from fossilizing support packages as product contracts.
