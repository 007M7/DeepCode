/**
 * Gate: every user-facing value has one owner, and no shipped file smuggles a
 * second one in.
 *
 * Two rules, both about the same failure — a value reaching the harness
 * through a path nobody ranked:
 *
 * 1. Production package source does not read `process.env` directly. A
 *    credential belongs to `ctx.credentials`, a user-configurable value to the
 *    environment snapshot plus its owner's resolve step, and a real
 *    process-launch fact to the app bootstrap. Each remaining read is listed
 *    below with the reason it is one of those.
 * 2. Shipped Cordis configuration does not inline a credential or an endpoint
 *    from the environment. Doing so re-creates the layer the snapshot exists
 *    to rank: `apiKey: !!js process.env.X` and `baseURL: !!js process.env.X`
 *    bypass both the credential seam and the endpoint ladder, and a project
 *    file could then decide where a key is sent.
 * @module scripts/verify-config-source-ownership
 */

import { globSync, readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

/**
 * Production package sources allowed to read `process.env`, each with the
 * reason it is a process fact rather than a user-configurable value. Adding a
 * row is a deliberate act: state which of the three owners it belongs to and
 * why it cannot go there.
 */
const ENV_READ_ALLOWLIST: Readonly<Record<string, string>> = {
  // The environment plane itself.
  'packages/util/environment/src/index.ts': 'defines the snapshot; the inherited environment is its input',
  'packages/ui/app-boot/src/index.ts': 'the app bootstrap that builds the snapshot and reads $DSH_SNAPSHOT',
  'packages/util/paths/src/index.ts': 'resolves $DSH_HOME before any snapshot exists',

  // Process-launch facts owned by the boundary that spawns or is spawned.
  'packages/subprocess/subprocess/src/index.ts': 'scrubs the parent environment for children',
  'packages/workflow/workflow-workerthread/src/host.ts': 'passes the parent environment to a worker thread',
  'packages/ui/tui/src/index.ts': 'reads $COLORTERM, a terminal capability of this process',
  'packages/lsp/lsp-local/src/index.ts': 'passes the parent environment to a language server it spawns',
  'packages/cordis/repository-plugin/src/index.ts': 'resolves an MCP manifest against the spawning environment',
  'packages/host/directory-picker-native/src/win32-dialog-host.ts': 'builds the child environment for the dialog worker it spawns',
  'packages/host/directory-picker-native/src/win32-dialog-worker.ts': 'the spawned worker reads the title its parent passed on the env channel',
  'packages/bash/pwsh-local/src/resolve.ts': 'locates pwsh through $ProgramFiles and $SystemRoot, Windows install layout rather than user configuration',

  // Bootstrap-only DSH_* switches, which no discovered file may set.
  'packages/skill/skill-local/src/index.ts': 'reads $DSH_AGENTS_HOME and $DSH_BUNDLED_SKILL_DIR, both bootstrap-only',
  'packages/web/web/src/index.ts': 'reads $DSH_WEB_SEARCH_PROVIDER and $DSH_WEB_FETCH_PROVIDER, both bootstrap-only',
  'packages/host/apiproxy/src/native-path-opener.ts': 'reads the WSL interop markers of this process to pick an opener',
  'packages/host/directory-picker-auto/src/index.ts': 'reads launch facts (display, SSH) of this process',
  'packages/host/directory-picker-auto/src/resolve.ts': 'reads launch facts (display, SSH) of this process',

  // Telemetry identity and consent, resolved once per process at bootstrap.
  'packages/telemetry/session-telemetry-otel/src/user-id.ts': 'derives a machine identity from process facts',
  'packages/sdk/telemetry/src/consent-resolver.ts': 'reads the SDK bootstrap consent switch',
  'packages/sdk/telemetry/src/anonymous-id.ts': 'derives a machine identity from process facts',

  // SDK and example bins: their own app bootstrap, outside the product CLI.
  'packages/sdk/sdk-client/src/client.ts': 'SDK host bootstrap',
  'packages/sdk/helper/src/features/builtin/provider.ts': 'SDK scaffolding reads the developer environment',
  'packages/sdk/helper/src/features/builtin/app.ts': 'SDK scaffolding reads the developer environment',
  'packages/sdk/helper/src/package-managers/package-manager.ts': 'detects the invoking package manager',
  'packages/sdk/create-sdk/src/create-wizard.ts': 'SDK scaffolding reads the developer environment',
  'packages/examples/jsonrpc-demo/src/bin.ts': 'demo bin bootstrap',
  'packages/examples/acp-demo/src/bin.ts': 'demo bin bootstrap',

  // Test and replay infrastructure.
  'packages/support/loader-smoke/src/index.ts': 'test launcher composing a child environment',
  'packages/support/llm-replay/src/index.ts': 'replay fixture switch',
  'packages/support/acp-snapshot/src/launcher.ts': 'snapshot launcher composing a child environment',

  // Browser bundle: `process.env` is replaced at build time, never read at runtime.
  'packages/client/runtime/src/client/contract/store.ts': 'build-time constant folded by the bundler',
}

/** Shipped Cordis configuration these rules apply to. */
const SHIPPED_CONFIG_GLOBS = [
  'apps/*/config/*.yml',
  'examples/*/*.cordis.yml',
  'examples/*/cordis.yml',
  // The Python runtime ships its own default composition inside the wheel.
  'python/*/src/**/cordis.yml',
]

/**
 * Config keys that must never be inlined from the environment. Line-anchored
 * on purpose: this is a tripwire for the shape people actually write, not a
 * YAML analysis. A folded scalar or a block-literal spelling would slip past
 * it, which is acceptable because the rule it guards is also stated in the
 * owning Agent Note and enforced by the adapters' own resolution.
 */
const INLINE_DENY = /^\s*(apiKey|baseURL|apiKeyEnv|authToken|headers)\s*:\s*!!js\b/

const failures: string[] = []

for (const file of globSync('packages/*/*/src/**/*.ts', { cwd: ROOT })) {
  const rel = file.split(sep).join('/')
  if (!readFileSync(resolve(ROOT, rel), 'utf8').includes('process.env')) continue
  if (rel in ENV_READ_ALLOWLIST) continue
  failures.push(
    `${rel}: reads process.env directly. A credential belongs to ctx.credentials, a user-configurable`
    + ' value to environmentOf(ctx) plus its owner\'s resolve step, and a process-launch fact to the app'
    + ' bootstrap. If it is genuinely one of those, add it to ENV_READ_ALLOWLIST with the reason.',
  )
}

for (const glob of SHIPPED_CONFIG_GLOBS) {
  for (const file of globSync(glob, { cwd: ROOT })) {
    const rel = file.split(sep).join('/')
    readFileSync(resolve(ROOT, rel), 'utf8').split('\n').forEach((line, index) => {
      if (!INLINE_DENY.test(line)) return
      failures.push(
        `${rel}:${String(index + 1)}: inlines a credential or endpoint from the environment.`
        + ' The adapter resolves apiKeyEnv through ctx.credentials and the endpoint through the'
        + ' environment snapshot; inlining here bypasses both ladders.',
      )
    })
  }
}

if (failures.length > 0) {
  process.stderr.write('verify-config-source-ownership: configuration source ownership violated:\n')
  for (const failure of failures) process.stderr.write(`  ${failure}\n`)
  process.exit(1)
}

const allowed = Object.keys(ENV_READ_ALLOWLIST).length
process.stdout.write(
  `verify-config-source-ownership: no unregistered process.env reads (${String(allowed)} allowlisted)`
  + ' and no credential or endpoint inlined in shipped configuration.\n',
)
