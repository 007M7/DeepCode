# Agent Note: Adopt execa for hand-rolled test subprocess plumbing

Status: proposed

English | [中文](2026-07-26-execa-for-test-subprocess-plumbing.zh.md)

## Problem

Roughly ten e2e/smoke files re-derive the same spawn-collect-timeout choreography by hand: `let stdout = ''` accumulation with `setEncoding` and `data` handlers, a `setTimeout` → `kill('SIGKILL')` deadline, and `once('exit')`/`once('error')` settlement, each with small variations. The sites: the inner spawn block of `runLoaderSmoke` (`packages/support/loader-smoke/src/index.ts`), `runBuiltBin` in `apps/cli/tests/built-bin.e2e.ts` and `packages/examples/cli-demo/tests/built-bin.e2e.ts`, `runBinExpectingExit` in `packages/examples/acp-demo/tests/built-bin.e2e.ts`, the built-lib e2e helpers in `lsp-local` and `code-runtime-worker`, the outer collector of `examples/tui-agent/tests/pty-harness.ts`, `examples/jsonrpc-agent/tests/keyless-smoke.e2e.ts`, and partially `apps/web/tests/smoke-real.e2e.ts` and `session-checkpoint-policy/tests/crash-recovery.e2e.ts`. Net deletable: ~100–150 lines of test infrastructure.

Two related test-infra hand-rolls compound the case:

- `packages/support/llm-mock-server/src/cli.ts` hand-tokenizes 17 value-taking `--flag value` options plus boolean flags (~45–60 lines of loop and value-extraction helpers) where the `node:util` `parseArgs` builtin is already the repo idiom (`cli-demo`, `acp-demo`, `verify-runtime-closure.ts`, `packages/sdk/scripts`).
- `apps/web/tests/smoke-real.e2e.ts` and `apps/web/tests/scaffold.ts` carry two verbatim copies of a regex `.env` parser (~20 lines) where the `process.loadEnvFile` builtin has exactly the required no-override semantics — and the vitest e2e/snapshot/web configs already load root `.env` with it before these files run, making the copies arguably dead.
- The snapshot harness hand-rolls three poll-until-deadline loops (`waitForPersistedTurnStart`/`waitForPersistedTurnEnd`/`waitForWorkspaceFile` in `packages/support/acp-snapshot/src/harness.ts`, ~55 lines) plus `waitForFile` in `crash-recovery.e2e.ts`, where `vi.waitFor`/`expect.poll` cover the shape — vitest is already a runtime dependency of `dsh-acp-snapshot`, so this adds nothing.

## Proposal

- Add `execa` as a root devDependency and rewrite the spawn-collect-timeout sites onto `await execa(cmd, args, { cwd, env, timeout, killSignal: 'SIGKILL', reject: false })`, whose result reports `{ stdout, stderr, exitCode, signal, timedOut }` as independent fields — matching the repo's own defensive-patterns rule to report orthogonal subprocess outcomes independently. Keep the genuinely custom parts custom: cli-demo's interrupt-on-marker mid-stream logic, jsonrpc's line-predicate protocol driving, and crash-recovery's SIGKILL-at-failpoint choreography.
- Swap `llm-mock-server`'s CLI tokenizer for `parseArgs` (numeric coercion, bounds, and cross-option constraints stay manual; pinned error-message texts update with the tests).
- Delete both `loadRootEnv` copies in favor of `process.loadEnvFile` in a try/catch, or remove them outright if the vitest-config loading already covers them.
- Replace the four poll loops with `vi.waitFor`/`expect.poll`, passing explicit `{ interval, timeout }` and throwing descriptive errors from the callback.

## Alternatives considered

- **`tinyexec` instead of execa.** Already in `node_modules` transitively via vitest, smaller API — but no kill-escalation, no rich error output embedding, and being transitive is not a contract; if the lighter package is preferred the swap shape is identical.
- **A repo-local shared spawn helper (no new dep).** Viable and cheaper on supply chain, but it keeps the maintenance of deadline/kill/settlement logic in-repo when a battle-tested package owns exactly this; contrary to the [dependency policy](../../implemented/process/2026-07-26-dependencies-over-hand-rolling.md), it also has to re-earn Windows behavior (taskkill, exit codes) that execa already carries.
- **`get-port`, `wait-on`, `tempy`, `tree-kill`.** Rejected individually: the repo's single port probe is break-even, the file waits are dominated by `vi.waitFor`, temp-dir handling already uses `mkdtemp` + `rm {recursive}` builtins everywhere, and acp-snapshot's `close()` is drain-ordering logic, not tree traversal.

## Acceptance criteria

- The listed sites spawn through execa (or the chosen equivalent); the hand-rolled collect/timeout blocks and the two `/* v8 ignore */` un-inducible OS-error branches in `loader-smoke` are gone.
- `llm-mock-server` CLI parses via `parseArgs`; its cli spec passes with updated message expectations.
- No hand-rolled `.env` parser remains under `apps/web/tests`.
- The affected e2e and snapshot suites pass on both POSIX and Windows CI lanes.

## Risks

- `loader-smoke` is a `src/` file under the per-file-100% coverage gate; the swap actually simplifies its coverage story (removes un-inducible branches) but the new call shape needs coverage.
- Each rewritten e2e must be re-run on both platforms; subtle differences in kill escalation or stdin-close semantics (`input: ''` for loader-smoke's stdin-close contract) are the risk to verify per site.
- execa is a new root devDependency (currently absent from the lockfile entirely); it is one of the most-depended-on packages on npm and actively maintained, so health is not a concern, but the exe/runtime closure is unaffected either way (tests only).
