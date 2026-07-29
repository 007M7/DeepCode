import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'

/**
 * Keyless smoke for the SOURCE `dsh` launcher: run `apps/cli/src/bin.ts`
 * with the exact production launch vector (`node --import tsx/esm`, the same
 * shape as `bin/dsh` and the root `dsh`/`demo:tui`/`demo:web` scripts) and
 * assert the piped-stdio TTY refusal. The Node compatibility matrix runs this
 * WHOLE file, so a Node release changing module hooks or TypeScript handling
 * breaks this gate instead of every developer's `pnpm dsh`; the built-bin
 * suite covers the published `lib/` entry, not this source chain.
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const dshSourceBin = 'apps/cli/src/bin.ts'

describe('dsh SOURCE launcher (node --import tsx/esm)', () => {
  it('boots the source entry and refuses pipes LOUD (non-zero exit + stderr)', async () => {
    const result = await execa(process.execPath, ['--import', 'tsx/esm', dshSourceBin], {
      cwd: repoRoot,
      input: '',
      timeout: 25_000,
      killSignal: 'SIGKILL',
      reject: false,
    })
    if (result.timedOut) {
      throw new Error(`dsh source launch did not exit within 25s. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    }
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('requires stdin and stdout to be interactive TTYs')
    expect(result.stderr).toContain('dsh -p')
    // The refusal happens before any plugin mounts: stdout stays silent.
    expect(result.stdout).toBe('')
  }, 30_000)
})
