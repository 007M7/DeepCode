# RFC: Classify product, integration, and support packages

Status: proposed

## Problem

`packages/` is flat. Core product packages, provider integrations, tool implementations, example UI support, and snapshot-only replay support all sit at the same level and look equally publishable. The [package README](../../../packages/README.md) already has a `FIXME(package-hierarchy)` noting that `ui-stdio` and `llm-replay` were extracted from examples mostly for reuse and coverage. The flat layout makes support packages appear more foundational than they are and forces publish/lint/doc scripts to special-case intent in prose or static lists.

This is not just cosmetic. A package's location currently says little about whether it is core API, an integration, an example harness helper, or test infrastructure. That makes future removal harder because every top-level package looks like part of the same public surface.

## Proposal

Introduce an explicit package classification and move packages accordingly, for example `packages/core/`, `packages/integrations/`, `packages/tools/`, `packages/testing/`, and `packages/examples/`, or an equivalent structure decided in the implementing PR. The important part is that example/test support packages are not indistinguishable from product core.

This proposal does not delete `llm-replay` or `ui-stdio` by itself. It makes their status honest: either they graduate into product packages with documented consumers, or they live under a support/testing/example classification where release and compatibility expectations are lower.

## Acceptance criteria

- Each package has an explicit classification visible from path or package metadata.
- Scripts that publish, lint publishability, or generate module graphs use the classification instead of an ad hoc static list.
- Docs explain which package classes are part of the product API.
- YAML loader paths and TypeScript path aliases are updated in one coordinated move.

## What we give up

The restructure churns imports, workspace globs, docs links, and package paths. That churn is acceptable pre-release if it prevents the flat layout from fossilizing a support package as a product contract.
