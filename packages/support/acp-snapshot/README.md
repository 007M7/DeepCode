# `@deepseek-ai/dsh-acp-snapshot`

The ACP snapshot suite kit: the shared machinery behind the keyless snapshot tier (`pnpm run test:snapshot`, [testing policy](../../../docs/testing.md)). An example gets a full snapshot suite from a scenario table plus a fixtures directory; every compare/guard mechanic lives here, under the per-file coverage gate, instead of being copied per example.

Three layers, importable separately:

- **`runScenario` (harness)** — boots the real agent bin as a subprocess via tsx (unbuilt, Loader path), drives it over ACP JSON-RPC stdio from a deterministic `input.json` script, tees raw stdout for the golden + purity check, and harvests every persisted session JSONL (parent + subagent children, primary-first) after a graceful stdin-EOF shutdown. Parameterized by `AgentUnderTest` (`binScript`, `configPath`, `tsconfigPath` — absolute paths; the subprocess cwd is a temp dir outside the repo).
- **Normalizers** — pure functions turning the two captured surfaces into stable text: `normalizeStdout` (JSON-RPC ids → first-seen sequence; UUIDs/cwd → tokens; doubles as the stdout-purity check), `normalizeSessionLog` (times zeroed, `seq` kept), and the composable `scrubRequestHeaders` (header bulk → `{{system}}`/`{{tools}}`, structure kept — [pinned-header RFC](../../../docs/rfc/implemented/testing/2026-07-06-pin-request-header-content-in-one-scenario.md)).
- **`defineAcpSnapshotSuite` (factory)** — registers the whole describe/it tree for a scenario table: per-scenario golden + re-persisted-log compares, record/refresh fixture write-back, the per-header-class pin with its live uniformity guard, and the fixture guard block (no orphan scenario dirs, required files present, exactly one pin per class, pinning fixtures well-formed, non-pinning fixtures header-scrubbed). Must be called at vitest collection time.

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
    binScript: fileURLToPath(new URL('../../../packages/ui/acp-agent/src/bin.ts', import.meta.url)),
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

A scenario booting a differently-composed tree sets its own `configPath` (an overlay whose basename still ends in `cordis.yml`, so the bin's replay swap finds the sibling `*cordis.snapshot.yml`) and, when that composition changes the request header, its own `headerClass` with its own pinning scenario — the acp-agent example's Code Mode scenarios are the template.

The example also ships a `cordis.snapshot.yml` replay overlay next to its `cordis.yml` (the bin swaps them under `DSH_SNAPSHOT=replay` — [single-source replay config RFC](../../../docs/rfc/implemented/testing/2026-07-04-single-source-acp-replay-config.md)); replay fixtures are served by [`dsh-llm-replay`](../llm-replay/README.md), which this package points at via the `DSH_SNAPSHOT_*` env vars it sets on the child. `pnpm run test:snapshot:record` calls the live LLM and rewrites the recorded scenarios' model fixtures; `pnpm run test:snapshot:refresh` stays keyless, runs the replay overlay, and rewrites stdout plus comparable session-log goldens from the committed model scripts. Fixture roles, record/replay/refresh semantics, and scenario-table fields are documented on `Scenario` and in the [snapshot RFC](../../../docs/rfc/implemented/testing/2026-06-19-acp-snapshot-tests.md).

Constraints: `suite.ts` imports vitest, so the package is importable only inside a vitest run (the harness and normalizers have no such dependency but ship from the same entry). ACP-specific by design — the harness speaks the SDK's `ClientSideConnection`. Permission round-trips are scriptable: `InputScript.permissionAnswers` is a FIFO queue of option-kind selections (`allow_once`, `reject_once`, …) the client maps to the agent-issued `optionId` at answer time; an absent or exhausted queue answers `cancelled`, and a kind the request never offered rejects the run (the agent is answered `cancelled`, so a tolerant agent cannot absorb the scenario bug).
