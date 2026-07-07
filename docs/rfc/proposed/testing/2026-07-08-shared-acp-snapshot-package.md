# RFC: Extract the ACP snapshot suite into a support package

Status: proposed

## Problem

The ACP snapshot tier ([snapshot RFC](../../implemented/testing/2026-06-19-acp-snapshot-tests.md)) is built from three modules that live inside one example's test directory: `snapshot-harness.ts` (boot the real bin subprocess, drive it over ACP JSON-RPC, harvest the persisted logs), `snapshot-normalize.ts` (the pure golden normalizers), and the ~150-line scenario body plus fixture guards in [acp.snapshot.ts](../../../../examples/acp-agent/tests/acp.snapshot.ts) (record/replay modes, the stdout-golden and log compares, the pinned-header uniformity guard, the orphan/required-file/single-pin meta-tests).

A second ACP example that wants snapshot coverage — the sandbox/approval composition is the immediate consumer — can only copy those modules, forking exactly the logic that must not drift: record write-back, header scrubbing, child-session harvest ordering. The spawn/client glue is already triplicated across [acp.e2e.ts](../../../../examples/acp-agent/tests/acp.e2e.ts), [hooks.e2e.ts](../../../../examples/acp-agent/tests/hooks.e2e.ts), and the harness, marked by `TODO(acp-test-harness)`.

Location also decides test rigor: the per-file 100% coverage gate measures `packages/*/*/src` only, so none of this machinery is measured — the same gap that moved `dsh-llm-replay` out of `examples/` into [packages/support](../../../../packages/support/README.md). The harness's subprocess lifecycle, teardown, and harvest-ordering branches are exercised only transitively, when a live scenario happens to hit them.

Finally, the harness's ACP client hardcodes `requestPermission → cancelled`, so an approval round-trip — the headline behavior of the sandbox composition — cannot be expressed at the snapshot tier at all. A new transcript surface must name its coverage at every tier at plan time; today the tier cannot express this one.

## Proposal

Create `packages/support/acp-snapshot` (`@deepseek-ai/dsh-acp-snapshot`), a support-tier package with three source modules; each example keeps only its scenario table, its `snapshots/` fixtures, its `cordis.snapshot.yml` overlay ([single-source replay config](../../implemented/testing/2026-07-04-single-source-acp-replay-config.md)), and the paths that identify its agent.

**`src/harness.ts`** — `runScenario` and the input-script/result types, moved intact, with the module-level path constants replaced by an explicit `AgentUnderTest` parameter (`binScript`, `configPath`, `tsconfigPath`): defaulting stays at the seam's consumer, which resolves them from its own `import.meta.url`. The internal spawn/tee/SDK-client wiring is factored so the e2e launcher duplication can migrate onto it later; that migration is out of scope here and the `TODO(acp-test-harness)` stays until it lands.

**`src/normalize.ts`** — the normalizers move verbatim with their spec. They stay hook-free: when a future event carries a new volatile field (an approval duration, say), the shared normalizer learns it in the same change, keeping one home for what "normalized" means rather than per-suite scrub extensions.

**`src/suite.ts`** — the `Scenario` type and `defineAcpSnapshotSuite(options)`, which registers the per-scenario `describe`/`it` tree and the fixture guard tests. Options carry the resolved `mode: 'replay' | 'record'` — reading `DSH_SNAPSHOT` stays at the edge, in the example's `*.snapshot.ts`. The guard logic (no orphan scenario dirs, required fixture files, exactly one pin, non-pinning fixtures are `scrubRequestHeaders` fixed points) is exported as pure assertion functions the registered tests call one-line-each, so failure paths are unit-testable without meta-running vitest. The pinned-header contract ([pinned-header RFC](../../implemented/testing/2026-07-06-pin-request-header-content-in-one-scenario.md)) becomes per-suite: each suite flags exactly one `pinsHeader` scenario and its uniformity guard compares only that suite's sessions, which is the guard's existing scope.

**Scripted permission answers** — `InputScript` gains an optional ordered `permissionAnswers` queue consumed by the harness client's `requestPermission`, each entry selecting a response by option **kind** (`allow_once`, `reject_once`, …); the harness maps kind to the agent-issued `optionId` at answer time, since ids are random per run while kinds are stable. An exhausted or absent queue falls back to today's `cancelled`, so existing scenarios and goldens are untouched. This is what lets a sandbox suite script an approval round-trip deterministically from `input.json`.

Repo wiring follows the [adding-a-package cookbook](../../../cookbook/adding-a-package.md): manifest per the workspace constraints (cordis peer+dev, `private`, standard `files`), references in the root and build tsconfigs (the `@deepseek-ai/dsh-*` paths wildcard already covers `packages/support/*/src`), a row in the support group README, and explicit `@agentclientprotocol/sdk`/`vitest`/`tsx` dependencies instead of inherited-by-walk-up resolution. [docs/testing.md](../../../testing.md) generalizes "scenarios live under `examples/acp-agent/tests/snapshots/`" to the owning example's `tests/snapshots/`.

Landing order is three commits on one PR: (1) the pure move plus parameterization, with `examples/acp-agent/tests/acp.snapshot.ts` collapsed to its scenario table and one `defineAcpSnapshotSuite` call; (2) the coverage work — a scripted fake ACP bin fixture (reads JSON-RPC frames on stdin, emits canned responses and session updates, writes synthetic session JSONL under `DSH_SNAPSHOT_SESSIONS_ROOT`) driving `harness.ts` through every step op, expect-error branch, child-harvest ordering, and teardown path, and `suite.spec.ts` registering synthetic replay- and record-mode suites against temp fixture dirs (record mode is keyless here: the live API sits behind the bin, and the fake bin needs none); (3) `permissionAnswers` with its unit coverage. The sandbox branch then merges master down and adds its own suite: scenario table, own pin scenario, own overlay, fixtures recorded via `test:snapshot:record`.

## Alternatives considered

- **Copy the modules into each example** — the fork this RFC exists to prevent: the record/guard logic is exactly the code that must stay byte-identical across suites, and examples are outside the coverage gate, so each copy is also unmeasured.
- **A shared module directory under `examples/`** — keeps the code outside the coverage gate and forces relative imports across example boundaries, against the package-name import convention; `examples/` leaves stay thin by design.
- **A `/testing` subpath export of `dsh-acp-agent`** — couples test infrastructure into a product package's surface and dependency set; `packages/support/` exists precisely for real-but-lower-compatibility dev/test packages, with `dsh-llm-replay` as the precedent this proposal completes.
- **Export raw test-body functions instead of a suite factory** — each example would re-own the `describe`/`it` skeleton (~80 lines of registration boilerplate per suite) for no flexibility gain; the factory keeps consumers to a scenario table plus one call, and the pure guard functions preserve unit-testability inside the factory design.
- **An injectable ACP `Client` factory instead of declarative `permissionAnswers`** — maximally flexible, but it leaks SDK client construction to every consumer and reopens per-example drift in exactly the layer being unified; a declarative queue keeps `input.json` the single scripting surface and stays golden-normalizable.
- **Generalize beyond ACP (a transport-agnostic snapshot harness)** — no second transport exists; the harness is ACP-shaped end to end (SDK client, JSON-RPC frames, `session/update` waiters), and a speculative abstraction would be a seam split ahead of any consumer.

## Acceptance criteria

- After the pure-move commit, `pnpm run test:snapshot` is green with zero byte changes under `examples/acp-agent/tests/snapshots/` — the machine proof that extraction changed no behavior.
- `pnpm run test:coverage` holds the new package's `src/` at per-file 100% with keyless unit specs; any `v8 ignore` carries its reason.
- `examples/acp-agent/tests/acp.snapshot.ts` contains no golden/compare/guard logic — only the scenario table, the agent paths, and the factory call.
- A harness unit test drives a `permissionAnswers` script through kind→`optionId` mapping and the exhaustion fallback, demonstrating the tier can express an approval round-trip before the sandbox suite needs it.
- `doc-sync`, `hygiene`, and `verify-module-graph` pass with the new package wired in.

## Risks

- **Per-file 100% on `suite.ts`** is the tightest constraint: `toMatchFileSnapshot` update semantics differ under CI, and factory-registered tests must be driven by real vitest collection. The pure-guard-function split plus synthetic-suite registration is the mitigation; a justified `v8 ignore` is the last resort, not the plan.
- **`vitest` becomes a `src` dependency** of a workspace package (the factory imports `describe`/`it`/`expect`), so importing `suite.ts` outside a vitest run throws — acceptable for a support-tier package and stated in its README, but it is a shape no other package has.
- **Fake-bin drift**: harness unit tests exercise plumbing against a scripted bin, not the real one. The real bin path stays exercised on every `test:snapshot` run, so drift surfaces there; the fake bin only owns branches the live suite cannot deterministically reach.
- **Per-suite pins duplicate header bulk**: each new suite commits one full ~8 KB header fixture. Accepted — a suite whose composition equals another's is the degenerate case the uniformity guard would surface, and one pinned line per genuinely distinct composition is the pinned-header design applied at its natural scope.
- The extraction touches the gating snapshot suite itself; a subtle behavior change would surface as golden churn. The zero-byte-diff acceptance criterion is the guard.
