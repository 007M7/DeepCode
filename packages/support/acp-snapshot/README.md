# `@deepseek-ai/dsh-acp-snapshot`

The ACP snapshot suite kit: the shared machinery behind the keyless snapshot tier (`pnpm run test:snapshot`, [testing policy](../../../docs/testing.md)). An example gets a full snapshot suite from a scenario table plus a fixtures directory; every compare/guard mechanic lives here, under the per-file coverage gate, instead of being copied per example.

Four layers, importable separately:

- **`launchAcpTestAgent` (launcher)** — boots a source agent under tsx or a built `lib` agent under plain Node from a supplied cwd, connects the SDK client over a raw-byte stdout tee, collects session updates and stderr, surfaces asynchronous spawn failures through startup, fails closed on unhandled permission requests, and owns graceful or signalled shutdown. Shutdown waits for process exit, inherited stdio closure, and ACP parser exhaustion before resolving or propagating a child error, so captures are complete and callers can remove owned paths after either outcome. When Windows accepts forced termination but publishes its exit marker asynchronously, shutdown gives that marker a bounded grace before treating fallback refusal as a second failure. Snapshot and ordinary e2e suites share this process boundary; a test supplies only agent paths, cwd, environment overrides, and any permission policy.
- **`runScenario` (harness)** — drives ACP JSON-RPC stdio from a deterministic `input.json` script through the launcher, tees raw stdout for the expected-output and purity checks, and harvests every persisted raw JSONL session log (parent and subagent children, primary-first) after graceful stdin EOF. `AgentUnderTest` supplies absolute `binScript`, optional `libBinScript`, `configPath`, and `tsconfigPath` paths because the subprocess cwd is outside the repo; `workspaceParent` may move the generated child cwd from the platform temp directory when that grant is itself under test. Startup failures preserve captured agent stderr in the rejected diagnostic.
- **Normalizers** — pure functions turning the two captured surfaces into stable text: `normalizeStdout` (JSON-RPC ids → first-seen sequence; UUIDs and every native/JavaScript filesystem spelling of the generated cwd → tokens, longest-first; cwd-rooted separators selected as canonical `/` or host-native; `session_info_update.updatedAt` → `{{updatedAt}}`; doubles as the stdout-purity check), `normalizeSessionLog` (times zeroed, `seq` kept, the same cwd-path policy), `scrubSystemPrompts` (prompt text → `{{system}}`), `scrubToolSchemas` (schema bulk → `{{tools}}`), and `scrubRequestHeaders` (all header bulk → `{{system}}`/`{{tools}}`/`{{messagePrefix}}` outside each pin, structure kept — [pinned-header Agent Note](../../../.agents/notes/implemented/testing/2026-07-06-pin-request-header-content-in-one-scenario.md)).
- **`defineAcpSnapshotSuite` (factory)** — registers the whole describe/it tree for a scenario table: per-scenario expected-output and re-persisted-log comparisons, record/refresh fixture write-back, rejection of structured `UNKNOWN_TOOL` results, the per-header-class pin (`system-prompt.expected.md` plus `tool-schemas.expected.json`) with its live uniformity guard, and the fixture guard block (no orphan scenario dirs, required files present, exactly one pin per class, every JSONL prompt/schema-scrubbed, non-pinning fixtures fully header-scrubbed). Refresh expands packed timing envelopes before aligning existing volatile event times, so switching between packed and unpacked layouts cannot shift later records; fresh chunk-fragment arrays remain authoritative. A newly inserted `session/title` receives its preceding event's time so feature-driven insertions do not churn the remainder of a fixture. Each scenario directory's `session.jsonl` plus contiguous `session.<n>.jsonl` siblings are the ordered primary/child inventory; the scenario table does not duplicate their count. Must be called at vitest collection time.

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

A scenario booting a differently-composed tree sets its own `configPath` (an overlay whose basename still ends in `cordis.yml`, so the bin's replay swap finds the sibling `*cordis.snapshot.yml`) and, when that composition changes the request header, its own `headerClass` with its own pinning scenario — the acp-agent example's Code Mode and filesystem scenarios are templates. `workspaceParent` moves the generated cwd outside the platform temp area when temporary-directory grants are themselves under test; the harness still owns and removes only the generated child. Each pinning directory stores the normalized full prompt sequence in generated `system-prompt.expected.md` and the corresponding full tool-schema sequence in generated `tool-schemas.expected.json`; `session.jsonl` stores `"system":"{{system}}","tools":"{{tools}}"` while retaining config, reason, and any model-visible prefix. A pin with legitimate mid-run header changes declares `expectedHeaderChanges`, which fixes the length of both sidecar sequences.

Every scenario compares `stdout.expected.jsonl` with cwd-rooted separators canonicalized to `/`. On Windows, `pinsNativeWindowsStdout` additionally compares the complete `stdout.expected.windows.jsonl` after the shared expected output and requires that sidecar exactly when enabled. A scenario whose driven behavior needs POSIX process semantics (e.g. cancelling a live bash call kills a detached process group) declares `posixOnly`, which skips its run test on Windows while the fixture guards keep covering its committed files everywhere.

The example also ships a `cordis.snapshot.yml` replay overlay next to its `cordis.yml` (the bin swaps them under `DSH_SNAPSHOT=replay` — [single-source replay config Agent Note](../../../.agents/notes/implemented/testing/2026-07-04-single-source-acp-replay-config.md)); replay fixtures are served by [`dsh-llm-replay`](../llm-replay/README.md), which this package points at via the `DSH_SNAPSHOT_*` env vars it sets on the child. `pnpm run test:snapshot:record` calls the live LLM and rewrites the recorded scenarios' model fixtures; `pnpm run test:snapshot:refresh` stays keyless, runs the replay overlay, and rewrites stdout, comparable session-log expected outputs, and each pin's prompt and tool-schema sidecars from the committed model scripts. Fixture roles, record/replay/refresh semantics, and scenario-table fields are documented on `Scenario` and in the [snapshot Agent Note](../../../.agents/notes/implemented/testing/2026-06-19-acp-snapshot-tests.md).

Constraints: `suite.ts` imports vitest, so the package entry is importable only inside a vitest run (the launcher, harness, and normalizers have no such dependency but ship from the same entry). ACP-specific by design — the launcher speaks the SDK's `ClientSideConnection`. Permission round-trips are scriptable: `InputScript.permissionAnswers` is a FIFO queue of option-kind selections (`allow_once`, `reject_once`, …) the client maps to the agent-issued `optionId` at answer time; an absent or exhausted queue answers `cancelled`, and a kind the request never offered rejects the run (the agent is answered `cancelled`, so a tolerant agent cannot absorb the scenario bug). Session config options are scriptable too: the `setConfigOption` step switches a knob over `session/set_config_option`, and `setConfigOptionExpectError` asserts the bridge rejects an unknown id or out-of-vocabulary value (the error frame stays in the transcript).

## Model Experience

None, as this test-only harness records, normalizes, and compares ACP transcripts without changing the agent's assembled model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Session harvest requires raw JSONL mode** — `runScenario` collects persisted `.jsonl` logs, so snapshot configs set `persistenceCompression: 'none'`; compressed JSONL and SQLite compositions have no snapshot-harvest path.
- **Built mode requires current artifacts** — run `pnpm run build` before selecting `DSH_EXAMPLE_MODE=lib`; source mode remains the zero-build path.
