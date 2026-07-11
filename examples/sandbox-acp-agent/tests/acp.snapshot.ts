import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineAcpSnapshotSuite, type Scenario } from '@deepseek-ai/dsh-acp-snapshot'

/**
 * Snapshot suite for the SANDBOXED composition (`../cordis.yml`, swapped to
 * the sibling `cordis.snapshot.yml` replay overlay by the bin under
 * `DSH_SNAPSHOT=replay`). Replay swaps only the MODEL for the recorded
 * transcript — every bash call re-executes for real under the host's actual
 * runner (Seatbelt on macOS, bwrap on Linux CI: ci.yml's snapshot lane
 * installs bubblewrap for exactly this), so the recorded scenarios double as
 * cross-backend confinement regression: an allowed command a runner change
 * starts denying fails replay outright. Their commands are limited to
 * `cat`/`printf` shapes whose bytes are identical across those backends and
 * across GNU/BSD userlands.
 *
 * Deliberately ABSENT: a scenario whose transcript carries a real sandbox
 * DENIAL. The harness-authored `[sandbox: file access denied …]` marker is
 * byte-stable, but the denied command's own stderr is the backend's dialect
 * (bwrap EROFS "Read-only file system", Landlock EACCES "Permission
 * denied", Seatbelt EPERM "Operation not permitted", GNU vs BSD phrasing on
 * top), and stderr reaches both compared surfaces — such a fixture replays
 * only on the platform that recorded it. The denial→marker path stays on
 * dsh-tool-bash's unit tests and the real-kernel sandbox e2e legs
 * (.github/workflows/sandbox.yml); the escalation scenarios below sidestep
 * it by having the USER assert the prior denial, so the recorded model
 * escalates without a platform-variant denial in the log.
 */
const SCENARIOS: Scenario[] = [
  // Protocol-only (keyless, authored): the session config-option surface
  // this composition adds — both advertised selects on session/new, the
  // complete refreshed state every session/set_config_option answers with,
  // and both rejection shapes — as committed wire bytes. No bash runs, so
  // this one still replays on runner-less hosts.
  { name: 'config-options', hasModelTurn: false, recorded: false },
  // The runtime mode-switching arc, and NECESSARILY the pinned-header
  // scenario: an approval-policy switch rewrites its prompt section, and the
  // resulting request/header-delta is legal only in the pinning scenario
  // (the factory's uniformity guard). The pin commits this composition's
  // full header — persona, tool schemas WITH the escalation fields — plus
  // the approval delta and its "changed by the user" notice verbatim. The
  // SANDBOX switch is deliberately silent (no section, no notice — the
  // sandbox RFC's visibility asymmetry): the recorded arc proves it by
  // BEHAVIOR, a confined write landing under the switched mode with no
  // header change.
  { name: 'mode-switching', hasModelTurn: true, recorded: true, pinsHeader: true, expectedHeaderDeltas: 1 },
  // The approval wire end-to-end, under the DEFAULT read-only/ask (a switch
  // would emit a header-delta the uniformity guard forbids here): the
  // escalating bash call streams, session/request_permission attaches to it
  // (allow-once / reject-once), and the scripted answer drives each branch —
  // an approved run executes CONFINED under the granted workspace-write; a
  // rejected one executes nothing and fails with the deterministic
  // rejection text.
  { name: 'escalation-approved', hasModelTurn: true, recorded: true },
  { name: 'escalation-rejected', hasModelTurn: true, recorded: true },
]

defineAcpSnapshotSuite({
  agent: {
    binScript: fileURLToPath(new URL('../../../packages/ui/acp-agent/src/bin.ts', import.meta.url)),
    configPath: fileURLToPath(new URL('../cordis.yml', import.meta.url)),
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  },
  snapshotsDir: join(dirname(fileURLToPath(import.meta.url)), 'snapshots'),
  scenarios: SCENARIOS,
  mode: process.env.DSH_SNAPSHOT === 'record' ? 'record' : 'replay',
})
