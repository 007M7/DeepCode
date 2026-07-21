# Testing policy

How this repo tests, tier by tier, and the rules that keep a green suite meaningful. Commands live in root [AGENTS.md](../AGENTS.md); linked Agent Notes carry the rationale.

## Tiers

- **Unit** (`pnpm run test`): vitest over `packages|examples/*/tests/**/*.spec.ts`, colocated with what they test. Every registry gets an HMR-safety test (dispose the contributing fiber, assert cleanup). Prefer edge cases, error paths, event ordering, concurrency races, and permanent contract regressions (see `packages/core/agent-loop/tests/contract-regressions.spec.ts`).
- **Coverage gate** (`pnpm run test:coverage`): the gating run, per-file 100% on `packages/*/*/src`. An uncovered line is often dead code the gate is correctly flagging for deletion, not a missing test to bolt on. Line coverage is necessary, never sufficient — it proves lines ran, not that the feature works as shipped.
- **Real-API e2e** (`pnpm run test:e2e`): with-key tests against live provider APIs — the DeepSeek model plus provider-specific smokes that gate on their own keys (`EXA_API_KEY`, `PERPLEXITY_API_KEY`, …); each suite self-skips without its key so keyless CI stays green ([real-API e2e Agent Note](../.agents/notes/implemented/testing/2026-06-19-real-api-e2e-ci.md)).
- **Snapshot** (`pnpm run test:snapshot`): transport-specific keyless expected outputs cover external presentation. ACP suites boot the real example subprocess, replay a recorded session, and diff normalized JSON-RPC plus the re-persisted log ([ACP snapshot Agent Note](../.agents/notes/implemented/testing/2026-06-19-acp-snapshot-tests.md)); the headless suite independently pins `stream-json` through its real one-shot subprocess. TUI completed journeys replay recorded primary/child JSONL through the real agent loop and tools before projecting ANSI into semantic terminal-state expected outputs; package-local snapshots retain transient renderer states, and a real PTY conversation covers the process boundary ([TUI snapshot Agent Note](../.agents/notes/implemented/testing/2026-07-18-tui-terminal-state-snapshots.md)). Use `pnpm run test:snapshot:record` when a model transcript must change and `pnpm run test:snapshot:refresh` when committed replay input remains correct; review every JSONL and expected-output diff. System-prompt/tool-schema content is pinned by one ACP scenario (`text-turn`) and tokenized in every other fixture, so a prompt or schema edit churns one committed line ([pinned-header Agent Note](../.agents/notes/implemented/testing/2026-07-06-pin-request-header-content-in-one-scenario.md)).

## The with-key policy: inference is cheap here

We are DeepSeek — do not ration real-API tests. A no-key test proves plumbing; only a with-key run proves the agent works against a real model. Write many: file-writing prompts, multi-turn conversations, tool use, cancellation mid-stream. Highest-value are **smoke tests** that boot the real example, send one real prompt, and check the world — they catch the "green unit tests, broken product" class that mocks structurally cannot ([postmortem 0001](postmortem/0001-acp-default-export-drops-inject.md)). The self-skip exists only so secretless CI and keyless contributors aren't blocked; it is not a cost signal. Every example ships both a keyless smoke and a with-key smoke ([examples/AGENTS.md](../examples/AGENTS.md)).

## Prefer the real implementation over a mock

Mock only the genuinely expensive or non-deterministic boundary (the LLM adapter, the network, the clock); keep everything downstream real. A hand-rolled stand-in proves the bridge moves bytes, not that the shipping tool behaves as asserted — the two drift while the test stays green. Example: bridge tool-call tests run the scripted mock MODEL but the real tool + real executor (`makeBridgeHarness({ withBash: true })` plugs `dsh-bash-local` + `dsh-tool-bash` and runs an actual `echo`).

Recovery tests separate pre/post-chunk failures by step and prove failed chunks derive no message or tool side effect. Cover exhaustion, cancellation, policy composition, persistence, status, wire counts, transport-closing idle timeouts, and shipping Loader composition.

## Verify the world, not the self-report

An e2e assertion re-runs the command or re-reads the file externally; a keyword probe on the agent's own output lets a cheating agent pass. Assert untouched files are byte-identical. e2e tests own their resources: create the harness in the test, dispose in `afterEach` (even on failure/retry/timeout); shared fixtures live in a plain `tests/harness.ts`, never another `*.e2e.ts` (importing a spec re-registers its `describe` and duplicates real API calls).

## Test the real entry path

- Product-visible plugins require a non-unit REAL-composition test. Hand-built `ctx.plugin(...)` suites are insufficient: boot test-only `cordis.yml` through Loader and app/process, mock only external/nondeterministic boundaries, and assert model-visible request/log, durable state, or user-visible output. Keep opt-ins out of shipped defaults.
- A guard only guards if the regression actually fails it. For a plugin without `inject` (bundle/composition plugins), a Loader smoke stays green under a broken export shape — add an explicit `expect('default' in mod).toBe(false)` plus an `unwrapExports` round-trip assertion, and prove it: introduce the regression, watch red, revert.
- "Real entry path" means the published artifact: a package `bin` runs built `lib/bin.js` under plain `node`, exposing failures tsx masks (settle races, module resolution, swallowed load failures). The same applies to non-index runtime entries (the worker-thread sibling `lib/worker.cjs`) and singleton modules shared across bundles (`packages/ui/jsonrpc/tests/built-scope-carrier.e2e.ts`). Keep the built-artifact smokes green (`packages/ui/*/tests/built-bin.e2e.ts`, `packages/code-runtime/code-runtime-worker/tests/built-lib.e2e.ts`), and assert a genuinely-missing config exits non-zero.

## Test subprocess launch modes

- CI and build-having test lanes run every example or Cordis-config subprocess from built `lib/` through the shared dual-mode launcher. Do not hand-write `--import tsx` for these subprocesses.
- Protocol and operating-system fixtures that do not load Cordis run erasable `.ts` directly with Node, without tsx or the root paths map.
- Only a test whose subject is source-path resolution may select `src`; state that contract in the test.

## When a snapshot test is required

Every non-trivial model- or human-visible change adds or updates a keyless scenario in the same PR through a runnable example's owning snapshot suite. Package tests, e2e assertions, mock/test-only compositions, and PR rationale do not replace the assembled transcript; extend the harness when needed. ACP surfaces use `examples/<name>/tests/snapshots/`, a scenario table over the [`dsh-acp-snapshot`](../packages/support/acp-snapshot/README.md) suite factory (`examples/acp-agent` is primary); `examples/headless-agent` owns the `stream-json` snapshot and replay fixtures. Completed interactive-terminal journeys use JSONL-driven scenarios under `examples/tui-agent/tests/snapshots/`; transient presentation uses the package-local semantic matrix, with a PTY case when input, Loader selection, or terminal teardown changes. New capability seams, lifecycle shapes, or transcript surfaces name every coverage tier at plan time and verify the harness can express it before implementation.
