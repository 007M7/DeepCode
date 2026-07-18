// Runtime profiles: which mode + cordis.yml + model to launch. Three options
// for the demo; more can be added without touching wiring.
//
//   - daemon-echo: Phase 2 primary path. Shell spawns the daemon bin, connects
//     over unix socket, reconnects across daemon crashes. Keyless mock echo.
//   - stdio-echo: Phase 1 fallback — direct child, no daemon. Keyless.
//   - stdio-deepseek: real DeepSeek adapter, reads DEEPSEEK_API_KEY from the
//     dev clone's .env. Uses the same jsonrpc-demo bin over stdio.
//
// All three ultimately serve the same DSH JSON-RPC v2 protocol; only the
// spawn topology and cordis config change.

'use strict'

const path = require('node:path')
const os = require('node:os')

/**
 * Resolve the DSH runtime SDK checkout. Three candidates, in order:
 *
 *   1. `DSH_DEV_ROOT` env — an explicit override wins over everything.
 *   2. In-repo detection: when this shell ships inside `deepseek-harness`
 *      itself (official-repo layout at `examples/desktop/`), the SDK is
 *      the repo root. Walk up from `startDir` looking for the
 *      `packages/examples/jsonrpc-demo/src/bin.ts` marker; the first
 *      ancestor that has it becomes HARNESS_DEV. This is what the first
 *      person to clone the official repo hits — nothing to configure.
 *   3. Sibling `deepseek-harness-dev/` — the workspace layout described
 *      in CLAUDE.md (~/harness/deepseek-harness-dev). Kept for the
 *      original dev workflow: this demo repo sitting next to a checkout
 *      of the runtime. Prefers `.worktrees/integration` when the daemon
 *      is materialized there (daemon-demo lives there until it lands on
 *      master).
 *
 * Extracted as a pure function so `test/harness-dev-resolve.test.js`
 * can lock the candidate ordering against a mock filesystem. Module
 * init below calls this with `__dirname` and `process.env`.
 *
 * @param {string} startDir — directory to walk up from (candidate 2)
 * @param {Record<string,string|undefined>} env — env source for DSH_DEV_ROOT
 * @param {{ accessSync: (p: string) => void }} fsAccess — injectable for tests
 * @returns {string} absolute path chosen as HARNESS_DEV
 */
function resolveHarnessDev(startDir, env, fsAccess) {
  const explicit = env.DSH_DEV_ROOT
  if (explicit) return path.resolve(explicit)
  // Candidate 2 — walk up (up to 6 levels) looking for the jsonrpc-demo
  // bin. Cap the walk so a shell launched from an unrelated deep
  // directory doesn't scan the filesystem root. The marker was chosen
  // because it exists on every branch of deepseek-harness that this
  // shell can boot against.
  const marker = path.join('packages', 'examples', 'jsonrpc-demo', 'src', 'bin.ts')
  let dir = startDir
  for (let i = 0; i < 6; i += 1) {
    try {
      fsAccess.accessSync(path.join(dir, marker))
      return dir
    } catch (_) { /* not this level, keep climbing */ }
    const parent = path.dirname(dir)
    if (parent === dir) break // hit filesystem root
    dir = parent
  }
  // Candidate 3 — sibling clone. Same behavior as the original resolver.
  const base = path.resolve(startDir, '..', '..', '..', 'deepseek-harness-dev')
  const integration = path.join(base, '.worktrees', 'integration')
  try {
    // Prefer the integration worktree only if daemon-demo is materialized there.
    const daemonDir = path.join(integration, 'packages', 'examples', 'daemon-demo')
    fsAccess.accessSync(daemonDir)
    return integration
  } catch (_) {
    return base
  }
}

const HARNESS_DEV = resolveHarnessDev(__dirname, process.env, require('node:fs'))

const jsonrpcBin = path.join(HARNESS_DEV, 'packages', 'examples', 'jsonrpc-demo', 'src', 'bin.ts')
const daemonBin = path.join(HARNESS_DEV, 'packages', 'examples', 'daemon-demo', 'src', 'bin.ts')
const configDir = path.resolve(__dirname, '..', '..', 'config')

// HARNESS_DEV phantom-path guard (2026-07-18, fix/harness-dev-guard).
//
// The block above resolves HARNESS_DEV against `__dirname` (i.e. src/main/),
// so when the shell is started from a worktree — say
// `~/harness/dsh-demo-worktrees/lane-<foo>/` — the base falls out to
// `~/harness/dsh-demo-worktrees/deepseek-harness-dev` which does not exist.
// Nothing checks that. The stdio profile then hands node those phantom .ts
// paths and spawn fires ENOENT with an empty stderr; the renderer sees
// `spawn ... ENOENT` and used to fall into the generic "Runtime file
// missing / configured path could not be opened" bucket, which pointed the
// user at "check the profile's base leaf" — the wrong hint entirely. The
// same failure mode also bites first-run downloaders who have installed the
// shell but not cloned the SDK yet (no sibling `deepseek-harness-dev`).
//
// This helper exists so main.js can preflight before every spawn. It
// returns the resolved paths on success and throws a self-describing error
// on failure — the message is what the user reads in the banner, so it
// names the exact path we tried and the two ways to fix it. Kept as a
// separate export from `profile()` because the existing tests
// (test/profiles.test.js, test/model-profile-guard.test.js) construct
// profile shapes from repositories where the SDK layout may or may not be
// materialized; only the real spawn path cares whether the bins exist.
function preflightRuntimeBinaries(name) {
  const p = profile(name)
  // Which bin the profile actually spawns. daemon-mode uses daemonBin
  // (packages/examples/daemon-demo), the two stdio profiles use jsonrpcBin
  // (packages/examples/jsonrpc-demo). The path is baked into args[2] under
  // the current profile builder — but rather than reparse argv we consult
  // p.mode which is authoritative.
  const missing = []
  if (p.mode === 'daemon') {
    try { require('node:fs').accessSync(daemonBin) } catch (_) { missing.push(daemonBin) }
  } else {
    try { require('node:fs').accessSync(jsonrpcBin) } catch (_) { missing.push(jsonrpcBin) }
  }
  if (missing.length > 0) {
    const err = new Error(
      `DSH runtime SDK not found at ${missing.join(', ')}. ` +
      `If you cloned deepseek-harness, the SDK is this repo itself and the ` +
      `shell auto-detects it — set DSH_DEV_ROOT only for custom layouts, ` +
      `or clone deepseek-harness as a sibling directory of this shell.`,
    )
    err.code = 'DSH_RUNTIME_SDK_NOT_FOUND'
    err.missingPaths = missing
    err.harnessDevRoot = HARNESS_DEV
    throw err
  }
  return { jsonrpcBin, daemonBin, harnessDev: HARNESS_DEV }
}

// The Plugins tab writes ~/.dsh-desktop/user-overlay.cordis.yml (an include
// leaf that references daemon-echo.yml with patches). When it exists we point
// the daemon at the overlay instead of the raw base — same wire, but the
// user's toggles are respected. Missing overlay → fall back to the base leaf
// so the demo still runs before onboarding.
function resolveDaemonLeaf(baseName = 'daemon-echo.yml') {
  const shellHome = process.env.DSH_DESKTOP_HOME || path.join(os.homedir(), '.dsh-desktop')
  const overlay = path.join(shellHome, 'user-overlay.cordis.yml')
  try {
    require('node:fs').accessSync(overlay)
    return overlay
  } catch (_) {
    return path.join(configDir, baseName)
  }
}

// Resolve tsx (the TS loader for --import) as an absolute file so node's
// --import resolution isn't affected by the parent's cwd. Falls back to the
// bare specifier if resolution fails so a broken layout at least yields a
// diagnosable "Cannot find package 'tsx'" instead of a silent early exit.
const tsxSpecifier = (() => {
  try {
    return require.resolve('tsx', { paths: [HARNESS_DEV] })
  } catch (_) {
    return 'tsx'
  }
})()
// Tell tsx which tsconfig to honor so path aliases resolve against the dev
// clone's paths map. Without this, tsx defaults to the closest tsconfig on
// disk, which for a demo launched from a sibling directory is missing.
const tsxTsconfigPath = path.join(HARNESS_DEV, 'tsconfig.json')

// Under Electron, process.execPath is the Electron binary, which treats our
// `--import tsx <bin>` argv as an app path ("Unable to find Electron app at
// .../tsx"). ELECTRON_RUN_AS_NODE makes that same binary behave as plain
// node. Harmless under real node (smoke tests), essential under `pnpm start`.
const runtimeEnvBase = {
  ELECTRON_RUN_AS_NODE: '1',
  TSX_TSCONFIG_PATH: tsxTsconfigPath,
  // Bug #155: the runtime spawns with a curated env, so the deepseek
  // profiles never saw the user's shell key. Pass through ONLY this one
  // key — never the whole process.env (approval: user directive).
  ...(process.env.DEEPSEEK_API_KEY ? { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY } : {}),
}

// Per-user runtime directory for the demo daemon's socket + lockfile. Unix
// sockets have a ~104-byte path budget so we keep this short. Ensured to
// exist eagerly so the daemon bin doesn't silent-exit on socket-bind failure
// when tmp gets swept between runs (`/var/folders/...` on macOS).
const runtimeDir = path.join(os.tmpdir(), 'dsh-desktop-demo')
const daemonSocket = path.join(runtimeDir, 'daemon.sock')
const daemonLockfile = path.join(runtimeDir, 'daemon.lock')
const daemonSessions = path.join(runtimeDir, 'sessions')
try {
  require('node:fs').mkdirSync(daemonSessions, { recursive: true })
} catch (_) { /* best-effort — the daemon will surface a real error if this fails */ }

// Which yaml leaf under `config/` each profile boots from. Kept as a map so
// callers that only need the leaf name (fs-parse in the Plugins tab, static
// validation, boot probe) don't have to reparse the spawn argv. daemon-echo
// is the only profile the user overlay is allowed to shadow — the other
// leaves are dedicated (deepseek/vibe) and get their own overlay lane later.
// See main.js activeBasePath() — caught the case where
// the shell hardcoded daemon-echo.yml on every profile and the Plugins tab
// showed the wrong leaf under stdio-deepseek.
const PROFILE_LEAF = {
  'daemon-echo': 'daemon-echo.yml',
  'stdio-echo': 'echo-jsonrpc.yml',
  'stdio-deepseek': 'deepseek-jsonrpc.yml',
  'daemon-vibe-echo': 'daemon-vibe.yml',
  'stdio-vibe-deepseek': 'deepseek-vibe.yml',
}

// Preflight (2026-07-18) P0 fix — model×profile NO_ADAPTER guard.
//
// User hit this in the field: with `daemon-echo` active (only the mock-llm
// plugin registers, exposing `mock-echo`) they picked `deepseek-v4-flash`
// from the composer's model dropdown and every send bounced back as
// `session finished (error): no adapter registered for model
// "deepseek-v4-flash" [NO_ADAPTER]`. The dropdown had shipped a static
// global list (renderer.js:KNOWN_MODELS) so it happily let users pick a
// model the active profile can't route.
//
// Source of truth = the yml leaf each profile boots against. Each entry
// below mirrors the `id: llm-…` block's `models:` list in
// `config/*.yml`, keyed by the profile id from PROFILE_LEAF above. Keep
// these two maps in lockstep; the linked yaml is the schema.
//
//   daemon-echo         daemon-echo.yml     → mock-llm         → mock-echo
//   stdio-echo          echo-jsonrpc.yml    → mock-llm         → mock-echo
//   stdio-deepseek      deepseek-jsonrpc.yml→ llm-deepseek     → v4-flash/pro
//   daemon-vibe-echo    daemon-vibe.yml     → mock-llm         → mock-echo
//   stdio-vibe-deepseek deepseek-vibe.yml   → llm-deepseek     → v4-flash/pro
//
// The renderer treats index 0 as the profile's default when the user's
// current selection is unsupported. Keeping the tuple ordered (`v4-pro`
// first for the vibe profile, `v4-flash` first for stdio-deepseek) matches
// each leaf's own `models:` order.
const PROFILE_MODELS = {
  'daemon-echo': ['mock-echo'],
  'stdio-echo': ['mock-echo'],
  'stdio-deepseek': ['deepseek-v4-flash', 'deepseek-v4-pro'],
  'daemon-vibe-echo': ['mock-echo'],
  'stdio-vibe-deepseek': ['deepseek-v4-pro', 'deepseek-v4-flash'],
}

/**
 * Which models the profile's yml leaf declares. Returns a frozen empty
 * array for unknown profiles (rather than throwing) so a stale profile
 * name in a persisted session doesn't crash the renderer.
 *
 * @param {string} name
 * @returns {readonly string[]}
 */
function modelsFor(name) {
  const list = PROFILE_MODELS[name]
  return Array.isArray(list) ? list.slice() : []
}

/**
 * @param {string} name — profile id
 * @returns {string} absolute path to the profile's base yaml leaf under
 *   `config/`. Throws for unknown profiles so callers fail loudly rather
 *   than silently defaulting to daemon-echo (the previous bug).
 */
function leafPathFor(name) {
  const leaf = PROFILE_LEAF[name]
  if (!leaf) throw new Error(`unknown profile: ${name}`)
  return path.join(configDir, leaf)
}

function profile(name) {
  switch (name) {
    case 'daemon-echo':
      return {
        mode: 'daemon',
        leafName: PROFILE_LEAF['daemon-echo'],
        daemon: {
          cmd: process.execPath,
          // resolveDaemonLeaf picks the user overlay when the Plugins tab or
          // onboarding step has written one, else the raw base leaf. Both are
          // valid daemon-demo inputs.
          args: ['--import', tsxSpecifier, daemonBin, resolveDaemonLeaf('daemon-echo.yml')],
          // Point cwd at a demo-owned tmp dir. The daemon writes .sessions
          // relative to cwd when persistenceRoot is relative, and running
          // from the dev clone tickles a silent early-exit under some node
          // sandbox conditions (empirically: same command from a mkdtemp
          // workdir works, from HARNESS_DEV cwd fails without stderr).
          cwd: runtimeDir,
          env: {
            ...runtimeEnvBase,
            DSH_DAEMON_SOCKET_PATH: daemonSocket,
            DSH_DAEMON_LOCKFILE_PATH: daemonLockfile,
            DSH_DAEMON_SESSIONS_ROOT: daemonSessions,
          },
          socketPath: daemonSocket,
        },
        model: 'mock-echo',
        label: 'daemon (unix socket, mock, no key)',
        protocolVersion: 2,
        capabilities: { interruptions: true },
      }
    case 'stdio-echo':
      return {
        mode: 'stdio',
        leafName: PROFILE_LEAF['stdio-echo'],
        cmd: process.execPath,
        args: ['--import', tsxSpecifier, jsonrpcBin, path.join(configDir, PROFILE_LEAF['stdio-echo'])],
        cwd: HARNESS_DEV,
        env: { ...runtimeEnvBase },
        model: 'mock-echo',
        label: 'stdio (direct, mock, no key)',
        protocolVersion: 2,
        capabilities: { interruptions: true },
      }
    case 'stdio-deepseek':
      return {
        mode: 'stdio',
        leafName: PROFILE_LEAF['stdio-deepseek'],
        cmd: process.execPath,
        args: ['--import', tsxSpecifier, jsonrpcBin, path.join(configDir, PROFILE_LEAF['stdio-deepseek'])],
        cwd: HARNESS_DEV,
        env: { ...runtimeEnvBase },
        model: 'deepseek-v4-flash',
        label: 'stdio · deepseek-v4-flash (needs DEEPSEEK_API_KEY)',
        protocolVersion: 2,
        capabilities: { interruptions: true },
      }
    // Vibe: same daemon topology as daemon-echo, plus the self-referential
    // cordis toolset (cordis_inspect / cordis_mount / cordis_unmount). The
    // mock-echo adapter cannot compose plugins, so the shell exposes the
    // "Vibe a plugin" entry as disabled under this profile — it's here so
    // the wiring is uniform, and so QA can boot the leaf without a key.
    case 'daemon-vibe-echo':
      return {
        mode: 'daemon',
        leafName: PROFILE_LEAF['daemon-vibe-echo'],
        daemon: {
          cmd: process.execPath,
          args: ['--import', tsxSpecifier, daemonBin, path.join(configDir, PROFILE_LEAF['daemon-vibe-echo'])],
          cwd: HARNESS_DEV,
          env: {
            ...runtimeEnvBase,
            DSH_DAEMON_SOCKET_PATH: daemonSocket,
            DSH_DAEMON_LOCKFILE_PATH: daemonLockfile,
            DSH_DAEMON_SESSIONS_ROOT: daemonSessions,
          },
          socketPath: daemonSocket,
        },
        model: 'mock-echo',
        label: 'vibe · echo (mock, no key — vibe entry disabled)',
        protocolVersion: 2,
        capabilities: { interruptions: true },
        vibeCapable: false,
      }
    case 'stdio-vibe-deepseek':
      return {
        mode: 'stdio',
        leafName: PROFILE_LEAF['stdio-vibe-deepseek'],
        cmd: process.execPath,
        args: ['--import', tsxSpecifier, jsonrpcBin, path.join(configDir, PROFILE_LEAF['stdio-vibe-deepseek'])],
        cwd: HARNESS_DEV,
        env: { ...runtimeEnvBase },
        model: 'deepseek-v4-pro',
        label: 'vibe · deepseek-v4-pro (needs DEEPSEEK_API_KEY)',
        protocolVersion: 2,
        capabilities: { interruptions: true },
        vibeCapable: true,
      }
    default:
      throw new Error(`unknown profile: ${name}`)
  }
}

module.exports = {
  profile,
  listProfiles: () => ['daemon-echo', 'stdio-echo', 'stdio-deepseek', 'daemon-vibe-echo', 'stdio-vibe-deepseek'],
  runtimePaths: { runtimeDir, daemonSocket, daemonLockfile, daemonSessions },
  resolveDaemonLeaf,
  resolveHarnessDev,
  leafPathFor,
  PROFILE_LEAF,
  PROFILE_MODELS,
  modelsFor,
  configDir,
  preflightRuntimeBinaries,
  // Exposed for tests + diagnostics; the actual spawn path uses the
  // preflight helper above.
  _HARNESS_DEV: HARNESS_DEV,
  _jsonrpcBin: jsonrpcBin,
  _daemonBin: daemonBin,
}
