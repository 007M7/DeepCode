# Testing policy

How this repo tests, tier by tier, and the rules that keep a green suite meaning something. Commands live in the root [AGENTS.md](../AGENTS.md) § Commands; the RFCs linked per tier carry the design rationale.

## Tiers

- **Unit** (`pnpm run test`): vitest over `packages|examples/*/tests/**/*.spec.ts`, colocated with what they test. Every registry gets an HMR-safety test (dispose the contributing fiber, assert cleanup). Excessive tests are welcome — err toward covering edge cases, error paths, event ordering, and concurrency races; review findings get regression tests (see `packages/core/agent-loop/tests/review-fixes.spec.ts`).
- **Coverage gate** (`pnpm run test:coverage`): the gating run, per-file 100% on `packages/*/*/src`. An uncovered line is often dead code the gate is correctly flagging for deletion, not a missing test to bolt on. Line coverage is necessary, never sufficient — it proves lines ran, not that the feature works as shipped.
- **Real-API e2e** (`pnpm run test:e2e`): with-key tests against live provider APIs — the DeepSeek model plus provider-specific smokes that gate on their own keys (`EXA_API_KEY`, `PERPLEXITY_API_KEY`, …); each suite self-skips without its key so keyless CI stays green ([real-API e2e RFC](rfc/implemented/testing/2026-06-19-real-api-e2e-ci.md)).
- **Snapshot** (`pnpm run test:snapshot`): boots the real example subprocess, replays a recorded session keyless, diffs normalized stdout + the re-persisted log against committed goldens ([snapshot RFC](rfc/implemented/testing/2026-06-19-acp-snapshot-tests.md)). Re-record with `pnpm run test:snapshot:record`; reviewing the golden diff is part of the review.

## The with-key policy: inference is cheap here

We are DeepSeek — do not ration real-API tests. A no-key test proves the plumbing; only a with-key run proves the agent works against a real model. Write many: real prompts that write files, multi-turn conversations, tool use, cancellation mid-stream. Cheapest and highest-value are **smoke tests** that boot the real example, send one real prompt, and check the world — they catch the "green unit tests, broken product" class that mocks structurally cannot ([postmortem 0001](postmortem/0001-acp-default-export-drops-inject.md)). The self-skip exists only so secretless CI and keyless contributors aren't blocked; it is not a cost signal. Every example ships a keyless smoke and — unless keyless-by-nature — a with-key smoke ([examples/AGENTS.md](../examples/AGENTS.md)).

## Prefer the real implementation over a mock

Mock only the genuinely expensive or non-deterministic boundary (the LLM adapter, the network, the clock); keep everything downstream real. A hand-rolled stand-in proves the bridge moves bytes, not that the shipping tool behaves as asserted — the two drift while the test stays green. Example: bridge tool-call tests run the scripted mock MODEL but the real tool + real executor (`makeBridgeHarness({ withBash: true })` plugs `dsh-bash-local` + `dsh-tool-bash` and runs an actual `echo`).

## Verify the world, not the self-report

An e2e assertion re-runs the command or re-reads the file externally; a keyword probe on the agent's own output lets a cheating agent pass. Assert untouched files are byte-identical. e2e tests own their resources: create the harness in the test, dispose in `afterEach` (even on failure/retry/timeout); shared fixtures live in a plain `tests/harness.ts`, never another `*.e2e.ts` (importing a spec re-registers its `describe` and duplicates real API calls).

## Test the real entry path

- A plugin shipped via `cordis.yml` needs at least one test through the REAL Loader path: hand-built `ctx.plugin({...})` mounts bypass `unwrapExports` and cannot catch a broken export shape ([postmortem 0001](postmortem/0001-acp-default-export-drops-inject.md); export-shape rules in [packages/AGENTS.md](../packages/AGENTS.md)).
- A guard only guards if the regression actually fails it. For a plugin without `inject` (bundle/composition plugins), a Loader smoke stays green under a broken export shape — add an explicit `expect('default' in mod).toBe(false)` plus an `unwrapExports` round-trip assertion, and prove it: introduce the regression, watch red, revert.
- "Real entry path" means the published artifact: the package `bin` points at built `lib/bin.js` under plain `node`, which tsx masks (settle races, module resolution, a swallowed load failure exiting 0). Keep the built-bin smokes green (`packages/ui/*/tests/built-bin.e2e.ts`), and assert a genuinely-missing config exits non-zero.
- An e2e that spawns an example from a temp cwd sets `TSX_TSCONFIG_PATH` to the repo-root tsconfig, or it silently falls back to stale built `lib/` ([examples/AGENTS.md](../examples/AGENTS.md)).

## When a snapshot test is required

Any change affecting the editor-facing transcript or end-to-end agent UX — the ACP bridge, the loop's observable output, tool presentation — adds or updates a scenario under `examples/acp-agent/tests/snapshots/` (or states in the PR why none applies). New capability seams, lifecycle shapes, or transcript surfaces name their coverage at every tier at plan time and verify the harness can express it — a harness gap is scheduled work, not a mid-build surprise.
