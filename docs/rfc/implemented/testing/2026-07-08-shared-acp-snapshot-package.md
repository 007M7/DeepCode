# RFC: Extract the ACP snapshot suite into a support package

Status: implemented

## Problem

The ACP snapshot tier ([snapshot RFC](2026-06-19-acp-snapshot-tests.md)) was built from three modules living inside one example's test directory: `snapshot-harness.ts` (boot the real bin subprocess, drive it over ACP JSON-RPC, harvest the persisted logs), `snapshot-normalize.ts` (the pure golden normalizers), and the ~150-line scenario body plus fixture guards in `acp.snapshot.ts` (record/replay modes, the stdout-golden and log compares, the pinned-header uniformity guard, the orphan/required-file/single-pin meta-tests).

A second ACP example could only copy record, normalization, and harvest logic that must stay consistent. Code under `examples/` also sat outside the package coverage gate, and the original harness could only cancel permission requests. The shared package makes the machinery measured and lets scenarios script approval answers.

## Decision

The machinery lives in [`packages/support/acp-snapshot`](../../../../packages/support/acp-snapshot/README.md) (`@deepseek-ai/dsh-acp-snapshot`); an example's `*.snapshot.ts` is its scenario table, its agent paths, and one factory call, over its own `snapshots/` fixtures and `cordis.snapshot.yml` overlay ([single-source replay config](2026-07-04-single-source-acp-replay-config.md)). Reading `DSH_SNAPSHOT` stays at that edge — the library takes a resolved `mode`.

**`src/harness.ts`** provides `runScenario` and its script/result types, parameterized by the agent's bin and config paths. Permission answers form a FIFO queue keyed by stable option kind rather than random option id. Missing answers cancel the request; an unavailable kind cancels the agent request and fails the scenario.

**`src/normalize.ts`** — the pure normalizers, hook-free by policy: when a future event carries a new volatile field (an approval duration, say), the shared normalizer learns it in the same change, keeping one home for what "normalized" means rather than per-suite scrub extensions.

**`src/suite.ts`** — the `Scenario` type and `defineAcpSnapshotSuite(options)`, registering the per-scenario compares, record/refresh fixture write-back, the header pin with its live uniformity guard, and the fixture guard block (no orphan scenario dirs, required files present, exactly one pin per class, every JSONL a `scrubSystemPrompts` fixed point, non-pinning fixtures also `scrubRequestHeaders` fixed points). A scenario directory's `session.jsonl` plus contiguous `session.<n>.jsonl` siblings are its ordered primary/child inventory, so the scenario table declares policy without duplicating a child count. The pinned-header contract ([pinned-header RFC](2026-07-06-pin-request-header-content-in-one-scenario.md)) is per-suite: each header class flags exactly one `pinsHeader` scenario, whose `system-prompt.golden.md` and JSONL tool list split the composed header into reviewable artifacts; the uniformity guard compares both against every live header in that class. A pinning scenario declares any legitimate changed-header count, and its Markdown artifact records every full changed prompt. The pure helpers (`sessionFixtureNames`, `fixtureContext`, `normalizedHeaders`, `normalizedSystemPrompts`, `formatSystemPromptSnapshot`, `headerChangeCount`) are exported from the module for direct unit coverage.

## Alternatives considered

- **Copy the modules into each example** — the fork this RFC exists to prevent: the record/guard logic is exactly the code that must stay byte-identical across suites, and examples are outside the coverage gate, so each copy is also unmeasured.
- **A shared module directory under `examples/`** — keeps the code outside the coverage gate and forces relative imports across example boundaries, against the package-name import convention; `examples/` leaves stay thin by design.
- **A `/testing` subpath export of `dsh-acp-demo`** — couples test infrastructure into a product package's surface and dependency set; `packages/support/` exists precisely for real-but-lower-compatibility dev/test packages, with `dsh-llm-replay` as the precedent this package completes.
- **Export raw test-body functions instead of a suite factory** — each example would re-own the `describe`/`it` skeleton (~80 lines of registration boilerplate per suite) for no flexibility gain; the factory keeps consumers to a scenario table plus one call, and the exported pure helpers preserve unit-testability inside the factory design.
- **An injectable ACP `Client` factory instead of declarative `permissionAnswers`** — maximally flexible, but it leaks SDK client construction to every consumer and reopens per-example drift in exactly the layer being unified; a declarative queue keeps `input.json` the single scripting surface and stays golden-normalizable.
- **Generalize beyond ACP (a transport-agnostic snapshot harness)** — no second transport exists; the harness is ACP-shaped end to end (SDK client, JSON-RPC frames, `session/update` waiters), and a speculative abstraction would be a seam split ahead of any consumer.

## Testing

Extraction preserved every existing ACP golden byte. The package's `src/` has per-file 100% coverage through a scripted ACP subprocess: harness tests cover every step operation, both expected-error branches, permission selection/fallback/impossible choice, environment forwarding, workspace seeding, and harvest ordering/noise/fallback; suite tests execute replay against committed synthetic fixtures and record against a temporary copy, plus the pure helpers. Two structurally unreachable guards retain reasoned coverage exclusions. The fake agent substitutes the `session/new` cwd into logs, including Darwin's `/var` realpath behavior, matching the real bin.

## Consequences

A new example gets the whole snapshot tier from a scenario table plus fixtures — the sandbox branch merges master down and adds its own suite (own pin scenario, own overlay, fixtures via `test:snapshot:record`, approvals via `permissionAnswers`). The costs: `suite.ts` imports vitest, so the package is importable only inside a vitest run — a shape no other package has, stated in its README; each suite pins its own ~8 KB header fixture (a genuinely distinct composition deserves its own pin; an identical one would be caught by that suite's uniformity guard); and the e2e launcher duplication remains (`TODO(acp-test-harness)`) — the harness is the extraction target when that migration lands.
