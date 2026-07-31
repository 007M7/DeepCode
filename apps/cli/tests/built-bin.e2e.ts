import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * Published-entry smoke for the `dsh` bin: run the built `lib/bin.js` under
 * plain Node (no tsx) with PIPED stdio and assert the TUI refuses to boot.
 * `dsh` is the sole terminal front door; the TUI owns no non-TTY fallback, so a
 * piped launch must exit nonzero with a stderr pointer at the one-shot `-p`
 * mode. The guard fires inside `runTui` BEFORE the Loader resolves the config
 * tree — a compose-time throw inside the tree is logged per-entry, not
 * rethrown, so without this guard a piped launch would settle into an idle
 * UI-less process. The bin resolves its workspace deps through the repo's
 * node_modules, so no external consumer is assembled; missing-config fail-loud
 * and full-boot coverage for the shared dsh-app-boot glue live in cli-demo's
 * built-bin suite, and interactive TTY behavior is PTY-covered by
 * apps/cli/tests. Skips before the bin is built.
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const dshBin = join(repoRoot, 'apps/cli/lib/bin.js')

/**
 * Run the built bin with PIPED stdio (stdin closed at EOF); resolve with output
 * + exit code. `env` isolates the Harness home for surfaces that read it.
 */
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

describe.skipIf(!existsSync(dshBin))('dsh BUILT bin (node lib/bin.js, no tsx)', () => {
  it('refuses pipes LOUD (non-zero exit + stderr) before booting the Loader', async () => {
    const { stdout, code, stderr } = await runBuiltBin()
    expect(code).not.toBe(0)
    expect(stderr).toContain('requires stdin and stdout to be interactive TTYs')
    expect(stderr).toContain('dsh -p')
    // The refusal happens before any plugin mounts: stdout stays silent.
    expect(stdout).toBe('')
  }, 30_000)

  describe('dsh --dump-config', () => {
    let home: string
    beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dsh-dump-bin-')) })
    afterEach(() => { rmSync(home, { recursive: true, force: true }) })

    it('prints the shipped TUI composition without booting or needing a TTY', async () => {
      const { stdout, code, stderr } = await runBuiltBin(['--dump-default-config'], { DSH_HOME: home })
      expect(code).toBe(0)
      expect(stderr).toBe('')
      // Base rows composed with the TUI overlay's surface values, `!!js`
      // expressions verbatim (unevaluated), and TUI-only inserted rows present.
      expect(stdout).toContain("name: '@deepseek-ai/dsh-agent-loop'")
      expect(stdout).toContain('model: deepseek-v4-pro')
      expect(stdout).toContain('cwd: !!js process.cwd()')
      expect(stdout).toContain("name: '@deepseek-ai/dsh-tui'")
      // Provenance comment separators name each section's source file.
      expect(stdout).toContain('# == base.cordis.yml')
      expect(stdout).toContain('# == base.cordis.yml, patched by tui.cordis.yml')
      expect(stdout).toContain('# == tui.cordis.yml')
    }, 30_000)

    it('layers the personal overlay in --dump-config and reports an unmatched patch on stderr', async () => {
      writeFileSync(join(home, 'config.yaml'), [
        '- id: agent-loop',
        '  config:',
        '    agents:',
        '      - id: main',
        '        provider: custom-provider',
        '        model: custom-model',
        '- id: only-on-web',
        '  config:',
        '    value: 1',
        '',
      ].join('\n'))
      const { stdout, code, stderr } = await runBuiltBin(['--dump-config'], { DSH_HOME: home })
      expect(code).toBe(0)
      expect(stdout).toContain('provider: custom-provider')
      expect(stdout).not.toContain('model: deepseek-v4-pro')
      // The personal layer appears in the patched row's provenance and the
      // skipped-patch warning carries its label.
      expect(stdout).toContain(`patched by tui.cordis.yml, ${join(home, 'config.yaml')}`)
      expect(stderr).toContain('patch: entry "only-on-web" not found')

      // The shipped view ignores the personal overlay entirely.
      const shipped = await runBuiltBin(['--dump-default-config'], { DSH_HOME: home })
      expect(shipped.stdout).not.toContain('custom-provider')
      expect(shipped.stdout).toContain('model: deepseek-v4-pro')
    }, 30_000)

    it('composes the web overlay for `dsh web --dump-config`', async () => {
      const { stdout, code } = await runBuiltBin(['web', '--dump-config'], { DSH_HOME: home })
      expect(code).toBe(0)
      expect(stdout).toContain("name: '@deepseek-ai/dsh-host-webserver'")
      expect(stdout).not.toContain("name: '@deepseek-ai/dsh-tui'")
    }, 30_000)
  })
})
