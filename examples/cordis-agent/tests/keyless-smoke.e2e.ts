import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

/**
 * Keyless Loader-path smoke for examples/cordis-agent: boot the real tree,
 * including tool-cordis resolved by package name, then close stdin without a
 * prompt and assert the banner. The dummy key never reaches a model call.
 */

const binScript = fileURLToPath(new URL('../../../packages/examples/stdio-demo/src/bin.ts', import.meta.url))
const configPath = fileURLToPath(new URL('../cordis.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

describe('cordis-agent keyless smoke (real cordis.yml via the Loader)', () => {
  it('boots the full plugin tree incl. tool-cordis, prints its banner, and exits cleanly on EOF', async () => {
    const { stdout } = await runLoaderSmoke({
      label: 'cordis-agent',
      tempDirPrefix: 'cordis-smoke-',
      binScript,
      configPath,
      tsconfigPath,
      env: { DEEPSEEK_API_KEY: 'keyless-smoke-no-call' },
    })
    expect(stdout).toContain('cordis-agent ready.')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
