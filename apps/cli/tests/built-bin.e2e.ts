import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/** Published-entry acceptance for raw argument errors and boot-free config dumps. */
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const dshBin = join(repoRoot, 'apps/cli/lib/bin.js')
const rawOverlay = fileURLToPath(new URL('./fixtures/raw-overlay.cordis.yml', import.meta.url))
const rawInvalidProvider = fileURLToPath(new URL('./fixtures/raw-invalid-provider.cordis.yml', import.meta.url))

async function runBuiltBin(
  args: readonly string[] = [],
  env: Record<string, string> = {},
): Promise<{ stdout: string; code: number; stderr: string }> {
  const result = await execa(process.execPath, [dshBin, ...args], {
    input: '',
    timeout: 25_000,
    killSignal: 'SIGKILL',
    reject: false,
    env,
  })
  if (result.timedOut) {
    throw new Error(`dsh built bin did not exit within 25s. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  }
  return { stdout: result.stdout, code: result.exitCode ?? -1, stderr: result.stderr }
}

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 20_000
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`dsh raw lifecycle marker did not appear: ${file}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

interface RawLifecycleFixture {
  home: string
  ready: string
  settled: string
  disposed: string
  overlay: string
}

function createRawLifecycleFixture(): RawLifecycleFixture {
  const home = mkdtempSync(join(tmpdir(), 'dsh-raw-lifecycle-'))
  const ready = join(home, 'ready')
  const settled = join(home, 'settled')
  const disposed = join(home, 'disposed')
  const plugin = join(home, 'lifecycle.mjs')
  const overlay = join(home, 'overlay.cordis.yml')
  writeFileSync(plugin, [
    "import { writeFileSync } from 'node:fs'",
    "export const name = 'raw-lifecycle-fixture'",
    "export const inject = ['sessionQuery']",
    'export function apply(ctx) {',
    '  let active = true',
    "  writeFileSync(process.env.RAW_READY_FILE, 'ready')",
    '  void ctx.loader.await().then(() => {',
    "    if (active) writeFileSync(process.env.RAW_SETTLED_FILE, 'settled')",
    '  })',
    '  ctx.effect(() => () => {',
    '    active = false',
    "    writeFileSync(process.env.RAW_DISPOSED_FILE, 'disposed')",
    '  })',
    '}',
    '',
  ].join('\n'))
  writeFileSync(overlay, [
    '- insert:',
    '    - id: raw-lifecycle-fixture',
    `      name: ${pathToFileURL(plugin).href}`,
    '',
  ].join('\n'))
  return { home, ready, settled, disposed, overlay }
}

function startRawLifecycle(fixture: RawLifecycleFixture) {
  return execa(process.execPath, [dshBin, '--config', fixture.overlay], {
    cwd: fixture.home,
    input: '',
    reject: false,
    env: {
      DSH_HOME: fixture.home,
      DSH_TELEMETRY_DISABLED: '1',
      RAW_READY_FILE: fixture.ready,
      RAW_SETTLED_FILE: fixture.settled,
      RAW_DISPOSED_FILE: fixture.disposed,
    },
  })
}

describe.skipIf(!existsSync(dshBin))('dsh BUILT bin (node lib/bin.js, no tsx)', () => {
  it('requires --config for the raw command and rejects removed commands', async () => {
    const bare = await runBuiltBin()
    expect(bare.code).toBe(1)
    expect(bare.stdout).toBe('')
    expect(bare.stderr).toContain('--config <path> is required')
    const help = await runBuiltBin(['--help'])
    expect(help.code).toBe(0)
    expect(help.stdout).toContain('dsh --config ./app.cordis.yml')
    expect(help.stdout).not.toMatch(/^\s+(?:tui|meta|upgrade)\b/mu)
    for (const command of ['tui', 'meta', 'upgrade']) {
      const removed = await runBuiltBin([command])
      expect(removed.code).toBe(1)
      expect(removed.stderr).not.toContain('experimental')
    }
  }, 30_000)

  it('reports a raw overlay boot failure without hanging', async () => {
    const result = await runBuiltBin(['--config', rawInvalidProvider], {
      DEEPSEEK_API_KEY: 'keyless-invalid-config',
      DSH_TELEMETRY_DISABLED: '1',
    })
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('llm-pi-ai')
  }, 30_000)

  it('applies an inserted raw plugin and disposes it on a startup-time signal', async () => {
    const fixture = createRawLifecycleFixture()
    const child = startRawLifecycle(fixture)
    try {
      await waitForFile(fixture.ready)
      child.kill('SIGTERM')
      const result = await child
      expect(result.exitCode).toBe(0)
      expect(result.signal).toBeUndefined()
      expect(existsSync(fixture.disposed)).toBe(true)
    } finally {
      child.kill('SIGKILL')
      rmSync(fixture.home, { recursive: true, force: true })
    }
  }, 30_000)

  it('fully settles a valid raw overlay and disposes it on a signal', async () => {
    const fixture = createRawLifecycleFixture()
    const child = startRawLifecycle(fixture)
    try {
      await waitForFile(fixture.settled)
      child.kill('SIGTERM')
      const result = await child
      expect(result.exitCode).toBe(0)
      expect(result.signal).toBeUndefined()
      expect(existsSync(fixture.disposed)).toBe(true)
    } finally {
      child.kill('SIGKILL')
      rmSync(fixture.home, { recursive: true, force: true })
    }
  }, 30_000)

  describe('config dump', () => {
    let home: string
    beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dsh-dump-bin-')) })
    afterEach(() => { rmSync(home, { recursive: true, force: true }) })

    it('prints the shipped base without a user layer', async () => {
      const { stdout, code, stderr } = await runBuiltBin(['--dump-default-config'], { DSH_HOME: home })
      expect(code).toBe(0)
      expect(stderr).toBe('')
      expect(stdout).toContain("name: '@deepseek-ai/dsh-agent-loop'")
      expect(stdout).toContain('agents: []')
      expect(stdout).toContain('# == base.cordis.yml')
    }, 30_000)

    it('composes the required raw overlay directly over the base', async () => {
      writeFileSync(join(home, 'config.yaml'), [
        '- id: agent-loop',
        '  config:',
        '    agents:',
        '      - id: personal',
        '        provider: personal-provider',
        '        model: personal-model',
        '',
      ].join('\n'))
      const { stdout, code, stderr } = await runBuiltBin(
        ['--config', rawOverlay, '--dump-config'],
        { DSH_HOME: home },
      )
      expect(code).toBe(0)
      expect(stdout).toContain('provider: configured-provider')
      expect(stdout).not.toContain('personal-provider')
      expect(stdout).toContain(`patched by ${rawOverlay}`)
      expect(stderr).toContain('patch: entry "absent-row" not found')
    }, 30_000)

    it('keeps the Web overlay and personal layer on the Web command', async () => {
      writeFileSync(join(home, 'config.yaml'), [
        '- id: agent-loop',
        '  config:',
        '    agents:',
        '      - id: personal',
        '        provider: personal-provider',
        '        model: personal-model',
        '',
      ].join('\n'))
      const { stdout, code } = await runBuiltBin(['web', '--dump-config'], { DSH_HOME: home })
      expect(code).toBe(0)
      expect(stdout).toContain("name: '@deepseek-ai/dsh-host-webserver'")
      expect(stdout).toContain('provider: personal-provider')
    }, 30_000)
  })
})
