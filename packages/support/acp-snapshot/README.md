# `@deepseek-ai/dsh-acp-snapshot`

The ACP snapshot suite kit: the shared machinery behind the keyless snapshot tier (`pnpm run test:snapshot`, [testing policy](../../../docs/testing.md)). An example gets a full snapshot suite from a scenario table plus a fixtures directory; every compare/guard mechanic lives here, under the per-file coverage gate, instead of being copied per example.

Three layers, importable separately:

- **`runScenario` (harness)** — boots the real agent bin as a subprocess via tsx (unbuilt, Loader path), drives it over ACP JSON-RPC stdio from a deterministic `input.json` script, tees raw stdout for the golden + purity check, and harvests every persisted session JSONL (parent + subagent children, primary-first) after a graceful stdin-EOF shutdown. Parameterized by `AgentUnderTest` (`binScript`, `configPath`, `tsconfigPath` — absolute paths; the subprocess cwd is a temp dir outside the repo).
- **Normalizers** — pure functions turning the two captured surfaces into stable text: `normalizeStdout` (JSON-RPC ids → first-seen sequence; UUIDs/cwd → tokens; doubles as the stdout-purity check), `normalizeSessionLog` (times zeroed, `seq` kept), `scrubSystemPrompts` (prompt text → `{{system}}`), `scrubToolSchemas` (schema bulk → `{{tools}}`), and `scrubRequestHeaders` (all header bulk → `{{system}}`/`{{tools}}`/`{{messagePrefix}}` outside each pin, structure kept — [pinned-header RFC](../../../docs/rfc/implemented/testing/2026-07-06-pin-request-header-content-in-one-scenario.md)).
- **`defineAcpSnapshotSuite` (factory)** — registers the whole describe/it tree for a scenario table: per-scenario golden + re-persisted-log compares, record/refresh fixture write-back, rejection of structured `UNKNOWN_TOOL` results, the per-header-class pin (`system-prompt.golden.md` plus `tool-schemas.golden.json`) with its live uniformity guard, and the fixture guard block (no orphan scenario dirs, required files present, exactly one pin per class, every JSONL prompt/schema-scrubbed, non-pinning fixtures fully header-scrubbed). Must be called at vitest collection time.

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

A scenario booting a differently-composed tree sets its own `configPath` (an overlay whose basename still ends in `cordis.yml`, so the bin's replay swap finds the sibling `*cordis.snapshot.yml`) and, when that composition changes the request header, its own `headerClass` with its own pinning scenario — the acp-agent example's Code Mode and filesystem scenarios are templates. Each pinning directory stores the normalized composed prompt in generated `system-prompt.golden.md` and the initial schemas plus schema deltas in generated `tool-schemas.golden.json`; `session.jsonl` stores `"system":"{{system}}","tools":"{{tools}}"` while retaining config, reason, and any model-visible prefix.

Examples use a `cordis.snapshot.yml` overlay with [`dsh-llm-replay`](../llm-replay/README.md). Recording calls the live model and updates model fixtures; keyless refresh replays those fixtures and updates derived stdout, session-log, prompt, and tool-schema snapshots. See the [snapshot RFC](../../../docs/rfc/implemented/testing/2026-06-19-acp-snapshot-tests.md).

`suite.ts` imports Vitest, so use this package only inside a Vitest run. The ACP-specific script queues permission answers by stable option kind and maps them to current option ids; a missing answer cancels, while an unavailable kind fails the scenario after cancelling the agent request. It can also set session config options or assert that unknown ids and values are rejected in the transcript.

## Model Experience

None, as this test-only harness records, normalizes, and compares ACP transcripts without changing the agent's assembled model request.

## Known Limitations and Deferred Work

- **Session harvest is JSONL-only** — `runScenario` collects persisted `.jsonl` logs, so an example composed over the SQLite persistence backend has no snapshot path.
- **The subprocess boots the unbuilt tsx/Loader path only** — the built-bin artifact is guarded by the separate `built-bin` e2e smokes, never by this tier.
