# `@deepseek-ai/dsh-acp-snapshot`

The ACP snapshot suite kit: the shared machinery behind the keyless snapshot tier (`pnpm run test:snapshot`, [testing policy](../../../docs/testing.md)). An example gets a full snapshot suite from a scenario table plus a fixtures directory; every compare/guard mechanic lives here, under the per-file coverage gate, instead of being copied per example.

Four layers, importable separately:

- **`launchAcpTestAgent` (launcher)** — boots an unbuilt ACP agent from a temp cwd, pins tsx to the repo tsconfig, connects the SDK client over a raw-byte stdout tee, collects session updates and stderr, surfaces asynchronous spawn failures through its startup lifecycle, fails closed on unhandled permission requests, and owns graceful or signalled shutdown. Shutdown waits for process exit, inherited stdio closure, and ACP parser exhaustion before resolving or propagating a child error, so captures are complete and callers can remove owned paths after either outcome. Snapshot and ordinary e2e suites share this process boundary; a test supplies only agent paths, cwd, environment overrides, and any permission policy.
- **`runScenario` (harness)** — boots the real agent bin as a subprocess via tsx (unbuilt, Loader path), drives it over ACP JSON-RPC stdio from a deterministic `input.json` script, tees raw stdout for the expected-output and purity checks, and harvests every persisted session JSONL (parent + subagent children, primary-first) after a graceful stdin-EOF shutdown. Parameterized by `AgentUnderTest` (`binScript`, `configPath`, `tsconfigPath` — absolute paths; the subprocess cwd is a temp dir outside the repo). Startup failures preserve captured agent stderr in the rejected diagnostic.
- **Normalizers** — pure functions turning the two captured surfaces into stable text: `normalizeStdout` (JSON-RPC ids → first-seen sequence; UUIDs/cwd → tokens; doubles as the stdout-purity check), `normalizeSessionLog` (times zeroed, `seq` kept), `scrubSystemPrompts` (prompt text → `{{system}}`), `scrubToolSchemas` (schema bulk → `{{tools}}`), and `scrubRequestHeaders` (all header bulk → `{{system}}`/`{{tools}}`/`{{messagePrefix}}` outside each pin, structure kept — [pinned-header Agent Note](../../../.agents/notes/implemented/testing/2026-07-06-pin-request-header-content-in-one-scenario.md)).
- **`defineAcpSnapshotSuite` (factory)** — registers the whole describe/it tree for a scenario table: per-scenario expected-output and re-persisted-log comparisons, record/refresh fixture write-back, rejection of structured `UNKNOWN_TOOL` results, the per-header-class pin (`system-prompt.expected.md` plus `tool-schemas.expected.json`) with its live uniformity guard, and the fixture guard block (no orphan scenario dirs, required files present, exactly one pin per class, every JSONL prompt/schema-scrubbed, non-pinning fixtures fully header-scrubbed). Each scenario directory's `session.jsonl` plus contiguous `session.<n>.jsonl` siblings are the ordered primary/child inventory; the scenario table does not duplicate their count. Must be called at vitest collection time.

A consuming `*.snapshot.ts` is the scenario table plus one factory call:

```ts
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineAcpSnapshotSuite, type Scenario } from '@deepseek-ai/dsh-acp-snapshot'

const SCENARIOS: Scenario[] = [
  { name: 'text-turn', hasModelTurn: true, recorded: true, pinsHeader: true },
]

defineAcpSnapshotSuite({
  agent: { // absolute paths, resolved from the suite's own location
    binScript: fileURLToPath(new URL('../../../packages/examples/acp-demo/src/bin.ts', import.meta.url)),
    configPath: fileURLToPath(new URL('../cordis.yml', import.meta.url)),
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  },
  snapshotsDir: join(dirname(fileURLToPath(import.meta.url)), 'snapshots'),
  scenarios: SCENARIOS, // exactly one entry per header class sets pinsHeader
  mode: process.env.DSH_SNAPSHOT === 'record'
    ? 'record'
    : process.env.DSH_SNAPSHOT === 'refresh'
      ? 'refresh'
      : 'replay',
})
```

A scenario booting a differently-composed tree sets its own `configPath` (an overlay whose basename still ends in `cordis.yml`, so the bin's replay swap finds the sibling `*cordis.snapshot.yml`) and, when that composition changes the request header, its own `headerClass` with its own pinning scenario — the acp-agent example's Code Mode and filesystem scenarios are templates. Each pinning directory stores the normalized full prompt sequence in generated `system-prompt.expected.md` and the corresponding full tool-schema sequence in generated `tool-schemas.expected.json`; `session.jsonl` stores `"system":"{{system}}","tools":"{{tools}}"` while retaining config, reason, and any model-visible prefix. A pin with legitimate mid-run header changes declares `expectedHeaderChanges`, which fixes the length of both sidecar sequences.

The example also ships a `cordis.snapshot.yml` replay overlay next to its `cordis.yml` (the bin swaps them under `DSH_SNAPSHOT=replay` — [single-source replay config Agent Note](../../../.agents/notes/implemented/testing/2026-07-04-single-source-acp-replay-config.md)); replay fixtures are served by [`dsh-llm-replay`](../llm-replay/README.md), which this package points at via the `DSH_SNAPSHOT_*` env vars it sets on the child. `pnpm run test:snapshot:record` calls the live LLM and rewrites the recorded scenarios' model fixtures; `pnpm run test:snapshot:refresh` stays keyless, runs the replay overlay, and rewrites stdout, comparable session-log expected outputs, and each pin's prompt and tool-schema sidecars from the committed model scripts. Fixture roles, record/replay/refresh semantics, and scenario-table fields are documented on `Scenario` and in the [snapshot Agent Note](../../../.agents/notes/implemented/testing/2026-06-19-acp-snapshot-tests.md).

Constraints: `suite.ts` imports vitest, so the package entry is importable only inside a vitest run (the launcher, harness, and normalizers have no such dependency but ship from the same entry). ACP-specific by design — the launcher speaks the SDK's `ClientSideConnection`. Permission round-trips are scriptable: `InputScript.permissionAnswers` is a FIFO queue of option-kind selections (`allow_once`, `reject_once`, …) the client maps to the agent-issued `optionId` at answer time; an absent or exhausted queue answers `cancelled`, and a kind the request never offered rejects the run (the agent is answered `cancelled`, so a tolerant agent cannot absorb the scenario bug). Session config options are scriptable too: the `setConfigOption` step switches a knob over `session/set_config_option`, and `setConfigOptionExpectError` asserts the bridge rejects an unknown id or out-of-vocabulary value (the error frame stays in the transcript).

## Model Experience

None, as this test-only harness records, normalizes, and compares ACP transcripts without changing the agent's assembled model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Session harvest requires raw JSONL mode** — `runScenario` collects persisted `.jsonl` logs, so snapshot configs set `persistenceCompression: 'none'`; compressed JSONL and SQLite compositions have no snapshot-harvest path.
- **The subprocess boots the unbuilt tsx/Loader path only** — the built-bin artifact is guarded by the separate `built-bin` e2e smokes, never by this tier.
