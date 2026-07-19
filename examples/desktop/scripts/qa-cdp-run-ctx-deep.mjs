// Real-machine isolated runner for the lane-ctx-deep shots (task #51).
// Boots Electron on a private CDP port with a private USER_DATA and
// DSH_DESKTOP_HOME under $TMPDIR (2026-07-18 postmortem — nothing here
// touches the user's real ~/.dsh-desktop), then invokes the shot script.
//
// Usage: node scripts/qa-cdp-run-ctx-deep.mjs

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { tmpdir } from 'node:os'

const WORKTREE = resolve(process.env.DSH_WORKTREE || process.cwd())
const PARENT = resolve(process.env.DSH_REPO || '/Users/ziya/harness/dsh-desktop-demo')
const ELECTRON = join(PARENT, 'node_modules/.bin/electron')
const CDP_PORT = Number(process.env.DSH_CTX_DEEP_PORT || 9285)
const USER_DATA = join(tmpdir(), 'dsh-ctx-deep-userdata')
const DSH_HOME = join(tmpdir(), 'dsh-ctx-deep-home')
const OUTDIR = join(WORKTREE, 'docs/demo-shots')
const SHOOT_SCRIPT = join(WORKTREE, 'scripts/qa-cdp-shoot-ctx-deep.mjs')

if (!existsSync(ELECTRON)) {
  console.error(`electron binary not found at ${ELECTRON}`)
  process.exit(2)
}
mkdirSync(OUTDIR, { recursive: true })
for (const dir of [USER_DATA, DSH_HOME]) {
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
  mkdirSync(dir, { recursive: true })
}
// Seed a minimal config so onboarding modal stays out of the way. Use
// echo-jsonrpc (jsonrpc-demo bin) — daemon-demo has been renamed to
// jsonrpc-demo upstream and the daemon-* config still points at the old
// path, so echo-jsonrpc is the correct keyless profile today.
writeFileSync(join(DSH_HOME, 'user-overlay.cordis.yml'), [
  '# ctx-deep QA seed overlay',
  'plugins:',
  `  - "@cordisjs/plugin-include":`,
  `      path: ${join(WORKTREE, 'config/echo-jsonrpc.yml')}`,
  '',
].join('\n'))
writeFileSync(join(DSH_HOME, 'config.json'), JSON.stringify({ role: 'coding', approvalMode: 'never' }))
writeFileSync(join(DSH_HOME, '.onboarded'), new Date().toISOString())

const child = spawn(ELECTRON, [
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${USER_DATA}`,
  '--disable-gpu',
  '--no-sandbox',
  '.',
], {
  cwd: WORKTREE,
  env: {
    ...process.env,
    DSH_DESKTOP_HOME: DSH_HOME,
    DSH_DEV_ROOT: process.env.DSH_DEV_ROOT || '/Users/ziya/harness/deepseek-harness-dev',
    DSH_MAXIMIZE: '1',
    DSH_QA: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
const logs = []
child.stdout.on('data', d => logs.push(String(d)))
child.stderr.on('data', d => logs.push(String(d)))

let up = false
for (let i = 0; i < 40; i++) {
  await sleep(500)
  try {
    const r = await fetch(`http://localhost:${CDP_PORT}/json/list`)
    if (r.ok) { up = true; break }
  } catch {}
}
if (!up) {
  child.kill('SIGKILL')
  console.error('electron did not come up on CDP :' + CDP_PORT)
  console.error(logs.join(''))
  process.exit(3)
}

// Run the shot script against our port.
const shooter = spawn(process.execPath, [SHOOT_SCRIPT, String(CDP_PORT), OUTDIR], {
  cwd: WORKTREE,
  stdio: 'inherit',
})
const rc = await new Promise((r) => shooter.on('exit', (code) => r(code)))
child.kill('SIGKILL')
process.exit(rc || 0)
