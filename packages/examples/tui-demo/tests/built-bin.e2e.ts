import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, rm, symlink, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * Published-entry smoke: run `lib/bin.js` under plain Node in a symlinked external consumer.
 * The TUI app owns no non-TTY fallback, so the piped subprocess must refuse to boot with a
 * nonzero exit and a stderr pointer at the one-shot CLI — the bin guards BEFORE the Loader
 * because a compose-time throw inside the tree is logged per-entry, not rethrown. The consumer
 * links only the bin's import chain (dsh-app-boot and its vendored Loader stack): the refusal
 * fires before any config is read, so no plugin tree is needed. Missing-config fail-loud and
 * full-boot coverage for the shared dsh-app-boot glue live in cli-demo's built-bin suite; it
 * skips before build, and interactive TTY behavior is PTY-covered by examples/tui-agent (the
 * one sanctioned PTY surface).
 */

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const tuiBin = join(repoRoot, 'packages/examples/tui-demo/lib/bin.js')

// Symlink each package the bin imports at module load by package name so plain
// Node resolves its built `main`, matching an installed dependency rather than
// tsconfig paths.
const dshPackages = ['examples/tui-demo', 'ui/app-boot']
const vendorPackages = ['cordis', 'loader', 'include', 'schemastery', 'cosmokit']

async function pkgName(absDir: string): Promise<string> {
  const json = JSON.parse(await readFile(join(absDir, 'package.json'), 'utf8')) as { name: string }
  return json.name
}

/** Build a temporary external consumer with built workspace/vendor links. */
async function makeConsumer(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tui-built-bin-'))
  const nm = join(dir, 'node_modules')
  for (const rel of dshPackages) {
    const abs = join(repoRoot, 'packages', rel)
    const target = join(nm, await pkgName(abs))
    await mkdir(dirname(target), { recursive: true })
    await symlink(abs, target)
  }
  for (const v of vendorPackages) {
    const abs = join(repoRoot, 'vendor', v)
    const target = join(nm, await pkgName(abs))
    await mkdir(dirname(target), { recursive: true })
    await symlink(abs, target)
  }
  return dir
}

/** Run the built bin in `cwd` with PIPED stdio; resolve with output + exit code. */
function runBuiltBin(cwd: string): Promise<{ stdout: string; code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    // NO tsx — this is the published `node lib/bin.js` path; the guard fires
    // before the Loader resolves the config tree.
    const child = spawn(process.execPath, [tuiBin, './cordis.yml'], {
      cwd,
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
    child.stdin.end()
  })
}

let consumer: string | undefined

afterEach(async () => {
  // Windows can briefly retain released handles after exit; retry removal.
  if (consumer !== undefined) await rm(consumer, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  consumer = undefined
})

describe.skipIf(!existsSync(tuiBin))('dsh-tui-demo BUILT bin (node lib/bin.js, no tsx)', () => {
  it('refuses pipes LOUD (non-zero exit + stderr) before booting the Loader', async () => {
    consumer = await makeConsumer()
    const { stdout, code, stderr } = await runBuiltBin(consumer)
    expect(code).not.toBe(0)
    expect(stderr).toContain('requires stdin and stdout to be interactive TTYs')
    expect(stderr).toContain('dsh-cli-demo')
    // The refusal happens before any plugin mounts: stdout stays silent.
    expect(stdout).toBe('')
  }, 30_000)
})
