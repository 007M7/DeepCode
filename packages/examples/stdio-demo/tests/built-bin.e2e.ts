import { spawn } from 'node:child_process'
import { cp, mkdtemp, mkdir, rm, symlink, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * Published-entry smoke: run `lib/bin.js` under plain Node in a symlinked external consumer and
 * require the banner plus echo round-trip. This catches built-only early-exit and config-resolution
 * failures masked by tsx source smokes. It skips before build; `--expose-internals` enables Cordis
 * bare-plugin loading, matching the demo command.
 */

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const stdioBin = join(repoRoot, 'packages/examples/stdio-demo/lib/bin.js')

// Symlink each required workspace package by package name so plain Node resolves its built `main`,
// matching an installed dependency rather than tsconfig paths.
const dshPackages = [
  'examples/agent-spine-demo', 'core/agent', 'core/session', 'core/system-prompt',
  'core/tools', 'core/agent-loop', 'llm/llm', 'bash/bash', 'bash/bash-local',
  'bash/tool-bash', 'support/invariants', 'ui/app-boot',
  'session-persistence/session-persistence',
  'session-persistence/session-persistence-jsonl', 'examples/stdio-demo',
  'ui/stdio', 'ui/tool-ask-user', 'ui/user-interaction',
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
 * Build a temporary external consumer with built workspace/vendor links and a mock-backed config.
 * The optional missing-but-disabled plugin verifies load guards accept intentionally fiber-less
 * entries rather than treating them as import failures.
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
  // The example's mock model + echo tool are example-local TS plugins (Node
  // 22.19+ — the engines floor — strips types natively, so plain `node` loads
  // them); they import the workspace packages the symlinked node_modules now
  // provides.
  await cp(join(repoRoot, 'examples/echo-agent/src'), join(dir, 'src'), { recursive: true })
  await writeFile(join(dir, 'cordis.yml'), [
    '- id: mock-llm',
    '  name: \'./src/mock-llm.ts\'',
    '- id: echo-tool',
    '  name: \'./src/echo-tool.ts\'',
    '- id: bash',
    '  name: \'@deepseek-ai/dsh-bash-local\'',
    '- id: stdio-agent',
    '  name: \'@deepseek-ai/dsh-stdio-demo\'',
    '  config:',
    '    model: mock-echo',
    '    persona: \'demo\'',
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
      env: { ...process.env, DSH_HOME: join(cwd, '.dsh'), DSH_AGENTS_HOME: join(cwd, '.agents') },
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
  // Windows can briefly retain released handles after exit; retry removal.
  if (consumer !== undefined) await rm(consumer, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  consumer = undefined
})

describe.skipIf(!existsSync(stdioBin))('dsh-stdio-demo BUILT bin (node lib/bin.js, no tsx)', () => {
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
    // A `disabled: true` entry settles without a fiber by design; the fail-loud entry-load
    // guard must not mistake it for a failed import. The nonexistent path makes that distinction
    // observable while the successful round-trip proves boot continued.
    consumer = await makeConsumer('DISABLED-OK ready.', true)
    const { stdout, code, stderr } = await runBuiltBin(consumer, './cordis.yml', 'echo hi')
    expect(stderr).not.toContain('failed to load')
    expect(stdout).toContain('DISABLED-OK ready.')
    expect(stdout).toContain('[tool result] ECHO: HI')
    expect(code).toBe(0)
  }, 30_000)

  it('fails LOUD (non-zero exit + stderr) on a config whose directory does not exist', async () => {
    // boot() pre-resolves the bootstrap include to an absolute URL, so a nonexistent config
    // directory cannot break its import; the include plugin's own read must fail loud instead.
    consumer = await makeConsumer('unused')
    const { code, stderr } = await runBuiltBin(consumer, '/nonexistent/dir/cordis.yml', '')
    expect(code).not.toBe(0)
    expect(stderr).toContain('config file not found')
  }, 30_000)

  it('fails LOUD (non-zero exit + stderr) on a missing config file in a real directory', async () => {
    // Existing directory plus missing config exercises the include plugin's fail-loud path.
    consumer = await makeConsumer('unused')
    const { code, stderr } = await runBuiltBin(consumer, './does-not-exist.yml', '')
    expect(code).not.toBe(0)
    expect(stderr).toContain('config file not found')
  }, 30_000)
})
