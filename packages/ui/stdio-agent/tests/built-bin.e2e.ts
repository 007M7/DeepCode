import { spawn } from 'node:child_process'
import { cp, mkdtemp, mkdir, rm, symlink, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * BUILT-ARTIFACT smoke for the published `dsh-stdio-agent` bin. The other smokes
 * boot `src/bin.ts` under tsx — but the package's `bin` field points at
 * `lib/bin.js`, run under plain `node` by a real consumer. tsx masks two failure
 * modes the built bin had: (1) `boot()` returned before the loader tree settled,
 * so the process exited 0 with no output and load errors surfaced as unhandled
 * rejections AFTER boot; (2) config-path resolution could fall back to the cwd.
 * This test runs the REAL `lib/bin.js` under `node` (NOT tsx) and asserts the
 * banner + echo round-trip, so a regression in the published entry fails here.
 *
 * It build-gates: if `lib/bin.js` is absent (suite run without `pnpm run build`)
 * the test SKIPS with a note. CI runs it after the build step. Setup mirrors a
 * real install: a temp dir whose `node_modules/@deepseek-ai/*` (and the vendored
 * `cordis`/`@cordisjs/*`) are symlinked to the built packages, a `cordis.yml`
 * that loads the app + the example's mock backend, and `node --expose-internals`
 * (the cordis Loader resolves bare plugin specifiers via its internal module
 * loader, active only under that flag — the same flag `demo:echo` passes).
 */

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const stdioBin = join(repoRoot, 'packages/ui/stdio-agent/lib/bin.js')

// Workspace packages the stdio app's tree needs, by repo-relative path. Each is
// symlinked into the temp consumer's node_modules under its package name, so
// plain `node` resolves the bare `@deepseek-ai/dsh-*` specifiers in cordis.yml
// to the built `lib/` (package.json `main`), exactly as an installed dep would.
const dshPackages = [
  'core/agent-core', 'core/agent', 'core/session', 'core/system-prompt',
  'core/tools', 'core/agent-loop', 'llm/llm', 'bash/bash', 'bash/bash-local',
  'bash/tool-bash', 'support/invariants',
  'session-persistence/session-persistence',
  'session-persistence/session-persistence-jsonl', 'ui/stdio-agent',
]
const vendorPackages = [
  'cordis', 'loader', 'include', 'timer', 'hmr', 'logger-console',
  'schemastery', 'cosmokit',
]

async function pkgName(absDir: string): Promise<string> {
  const json = JSON.parse(await readFile(join(absDir, 'package.json'), 'utf8')) as { name: string }
  return json.name
}

/**
 * Build a temp consumer dir: `node_modules` with the workspace + vendor packages
 * symlinked in, a `src/` carrying the example mock backend, and a `cordis.yml`
 * that wires them onto the stdio app. Returns the dir (caller removes it).
 *
 * `disabledBrokenEntry` appends an entry that points at a non-existent plugin but
 * is marked `disabled: true`. The Loader leaves a disabled entry fiber-less by
 * design, so it exercises that the fail-loud entry-load guard does NOT mistake a
 * valid disabled entry for a failed import.
 */
async function makeConsumer(welcome: string, disabledBrokenEntry = false): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'stdio-built-bin-'))
  const nm = join(dir, 'node_modules')
  for (const rel of dshPackages) {
    const abs = join(repoRoot, 'packages', rel)
    const name = await pkgName(abs)
    const target = join(nm, name)
    await mkdir(dirname(target), { recursive: true })
    await symlink(abs, target)
  }
  for (const v of vendorPackages) {
    const abs = join(repoRoot, 'vendor', v)
    const name = await pkgName(abs)
    const target = join(nm, name)
    await mkdir(dirname(target), { recursive: true })
    await symlink(abs, target)
  }
  // The example's mock model + echo tool are example-local TS plugins (Node 24+
  // strips types natively, so plain `node` loads them); they import the workspace
  // packages the symlinked node_modules now provides.
  await cp(join(repoRoot, 'examples/echo-agent/src'), join(dir, 'src'), { recursive: true })
  await writeFile(join(dir, 'cordis.yml'), [
    '- id: mock-llm',
    '  name: \'./src/mock-llm.ts\'',
    '- id: echo-tool',
    '  name: \'./src/echo-tool.ts\'',
    '- id: bash',
    '  name: \'@deepseek-ai/dsh-bash-local\'',
    '- id: stdio-agent',
    '  name: \'@deepseek-ai/dsh-stdio-agent\'',
    '  config:',
    '    model: mock-echo',
    '    systemPrompt: \'demo\'',
    `    welcome: '${welcome}'`,
    ...disabledBrokenEntry
      ? ['- id: off', '  name: \'./src/does-not-exist.ts\'', '  disabled: true']
      : [],
    '',
  ].join('\n'))
  return dir
}

/** Run the built bin in `cwd` against `configArg` with one stdin line; resolve with stdout/stderr + exit code. */
function runBuiltBin(cwd: string, configArg: string, line: string): Promise<{ stdout: string; code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    // --expose-internals: the cordis Loader resolves bare plugin specifiers via
    // its internal module loader (active only under this flag); demo:echo passes
    // it too. NO tsx — this is the published `node lib/bin.js` path.
    const child = spawn(process.execPath, ['--expose-internals', stdioBin, configArg], {
      cwd,
      // Mock model: never calls the network, so no key needed.
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (c: string) => { stdout += c })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (c: string) => { stderr += c })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`built bin did not exit within 25s. stdout:\n${stdout}\nstderr:\n${stderr}`))
    }, 25_000)
    child.on('exit', (code) => { clearTimeout(timer); resolve({ stdout, code: code ?? -1, stderr }) })
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
    child.stdin.write(`${line}\n`)
    child.stdin.end()
  })
}

let consumer: string | undefined

afterEach(async () => {
  if (consumer !== undefined) await rm(consumer, { recursive: true, force: true })
  consumer = undefined
})

describe.skipIf(!existsSync(stdioBin))('dsh-stdio-agent BUILT bin (node lib/bin.js, no tsx)', () => {
  it('boots the published bin, prints its banner, and runs the echo tool round-trip', async () => {
    consumer = await makeConsumer('BUILT-BIN-OK ready.')
    const { stdout, code, stderr } = await runBuiltBin(consumer, './cordis.yml', 'echo hi')
    expect(stderr).not.toContain('UNHANDLED')
    expect(stderr).not.toContain('without inject')
    // The banner proves boot() awaited the tree (the settle-race regression would
    // exit 0 with empty stdout); the round-trip proves the whole app mounted.
    expect(stdout).toContain('BUILT-BIN-OK ready.')
    expect(stdout).toContain('[tool call] echo')
    expect(stdout).toContain('[tool result] ECHO: HI')
    expect(code).toBe(0)
  }, 30_000)

  it('boots cleanly when the config disables an (otherwise unresolvable) entry', async () => {
    // A `disabled: true` entry settles without a fiber by design; the fail-loud
    // entry-load guard must NOT mistake it for a failed import. Even though its
    // plugin path does not exist, the app boots and the round-trip works.
    consumer = await makeConsumer('DISABLED-OK ready.', true)
    const { stdout, code, stderr } = await runBuiltBin(consumer, './cordis.yml', 'echo hi')
    expect(stderr).not.toContain('failed to load')
    expect(stdout).toContain('DISABLED-OK ready.')
    expect(stdout).toContain('[tool result] ECHO: HI')
    expect(code).toBe(0)
  }, 30_000)

  it('fails LOUD (non-zero exit + stderr) on a config whose directory does not exist', async () => {
    // A consumer who typos the config path must get a clear failure, not silent
    // success. This dir does not exist, so the include PLUGIN itself fails to
    // import; the cordis Loader logs that and leaves the entry with no fiber (no
    // rejection), which `boot()`'s entry-load check turns into a thrown error.
    consumer = await makeConsumer('unused')
    const { code, stderr } = await runBuiltBin(consumer, '/nonexistent/dir/cordis.yml', '')
    expect(code).not.toBe(0)
    expect(stderr).toContain('failed to load')
  }, 30_000)

  it('fails LOUD (non-zero exit + stderr) on a missing config file in a real directory', async () => {
    // The config DIRECTORY exists (the include plugin imports), but the file does
    // not — the include's init throws "config file not found", which surfaces as
    // an unhandled rejection the fail-loud guard turns into a non-zero exit.
    consumer = await makeConsumer('unused')
    const { code, stderr } = await runBuiltBin(consumer, './does-not-exist.yml', '')
    expect(code).not.toBe(0)
    expect(stderr).toContain('config file not found')
  }, 30_000)
})
