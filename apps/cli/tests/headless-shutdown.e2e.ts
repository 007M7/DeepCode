import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'
import { runTuiPtySmoke } from './pty-harness.ts'

const dshBinScript = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const neverDisposePlugin = pathToFileURL(
  fileURLToPath(new URL('./fixtures/never-dispose.mjs', import.meta.url)),
).href

describe.skipIf(process.platform === 'win32')('headless process shutdown (real Loader tree in a PTY)', () => {
  it('lets a second Ctrl+C force exit while the first signal is draining', async () => {
    const output = await runTuiPtySmoke({
      label: 'dsh headless repeated Ctrl+C',
      tempDirPrefix: 'dsh-headless-shutdown-',
      binScript: dshBinScript,
      tsconfigPath,
      configArgs: ['-p', 'never complete'],
      env: { DEEPSEEK_API_KEY: 'keyless-shutdown-no-call', DSH_TELEMETRY_DISABLED: '1' },
      expectedExitCode: 130,
      timeoutMs: 15_000,
      prepare: async (cwd) => {
        const home = join(cwd, '.dsh')
        await mkdir(home, { recursive: true })
        await writeFile(join(home, 'config.yaml'), [
          '- insert:',
          '    - id: never-dispose',
          `      name: '${neverDisposePlugin}'`,
          '',
        ].join('\n'))
      },
      actions: [
        { waitFor: 'dsh: observing at ', send: '\u0003' },
        { waitFor: 'dsh-test: never-dispose started', send: '\u0003' },
      ],
    })
    expect(output).toContain('dsh: observing at ')
    expect(output).toContain('dsh-test: never-dispose started')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
