import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'
import { runTuiPtySmoke } from '../../tui-agent/tests/pty-harness.ts'

const binScript = fileURLToPath(new URL('../../../apps/cli/src/bin.ts', import.meta.url))
const configPath = fileURLToPath(new URL('../cordis.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

describe('cordis-agent keyless smoke (real Loader tree in a PTY)', () => {
  it('boots the full tool-cordis tree and exits cleanly through the TUI', async () => {
    const output = await runTuiPtySmoke({
      label: 'cordis-agent',
      tempDirPrefix: 'cordis-agent-smoke-',
      binScript,
      configPath,
      tsconfigPath,
      env: { DEEPSEEK_API_KEY: 'keyless-smoke-no-call' },
      actions: [{ waitFor: 'cordis-agent ready.', send: '/exit\r' }],
    })
    expect(output).toContain('cordis-agent ready.')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
