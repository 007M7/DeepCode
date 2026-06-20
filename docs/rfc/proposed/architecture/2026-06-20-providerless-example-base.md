# RFC: Make the shared example base providerless

Status: proposed

## Problem

The examples have two shared base files: [examples/base-core.yml](../../../../examples/base-core.yml) is providerless, while [examples/base.yml](../../../../examples/base.yml) includes that core plus the real `llm-deepseek` adapter. Snapshot replay needs the providerless core with `llm-replay`, because loading the real adapter without a key throws. The normal demos need the real adapter. The result is a naming inversion: the file named `base.yml` is not the reusable base for all examples, while the true base is `base-core.yml`.

The split is understandable, but it makes every config explanation longer. It also leads to awkward test setup like a keyless smoke test carrying a dummy API key so an adapter can boot even though the model is not called.

## Proposal

Rename the providerless core to [examples/base.yml](../../../../examples/base.yml) and make adapter selection explicit in each concrete example. The coding and ACP real configs add a tiny `llm-deepseek` include or local block; snapshot config adds `llm-replay`. Delete [examples/base-core.yml](../../../../examples/base-core.yml).

The shared base should contain only provider-neutral services and tools: `llm`, sessions, system prompt, tools, agents, invariants, bash executor, and bash tool schemas. Anything that chooses a model provider belongs at the leaf config.

## Acceptance criteria

- [examples/base.yml](../../../../examples/base.yml) is providerless.
- [examples/base-core.yml](../../../../examples/base-core.yml) is deleted.
- Real demo configs explicitly add the DeepSeek adapter.
- Snapshot replay config includes the same providerless base and its replay adapter.
- The [examples README](../../../../examples/README.md), example-specific READMEs, and RFC references stop explaining "base = base-core plus adapter".

## What we give up

Real demos lose one layer of convenience: each must opt into the adapter. That is the right default for examples, because adapter choice is the variable part and providerless wiring is the shared product core.
