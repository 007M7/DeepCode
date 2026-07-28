import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { Sandbox, SandboxNotFoundError } from '@deepseek-ai/dsh-e2b'

const fixtureRoot = fileURLToPath(new URL('../../../../examples/headless-agent/tests/fixtures/e2b/e2b/', import.meta.url))
const binScript = join(fixtureRoot, 'bin.ts')
const configPath = join(fixtureRoot, 'cordis.yml')
const tsconfigPath = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

describe.skipIf(!process.env.E2B_API_KEY)('E2B live Loader composition', () => {
  it('shares remote state across FS and Bash without creating host workspace files', async () => {
    const { stdout, stderr } = await runLoaderSmoke({
      label: 'E2B composition',
      tempDirPrefix: 'dsh-e2b-composition-',
      binScript,
      libBinScript: binScript,
      configPath,
      tsconfigPath,
      processTimeoutMs: 90_000,
      inspect: async (cwd) => {
        await expect(access(join(cwd, 'from-fs.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(access(join(cwd, 'from-bash.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
      },
    })

    expect(stderr).toBe('')
    const output = JSON.parse(stdout) as Record<string, unknown>
    expect(output).toMatchObject({
      bashRead: 'written-by-fs\n',
      fsRead: 'written-by-bash\n',
    })
    const apiKey = process.env.E2B_API_KEY
    if (apiKey === undefined) throw new Error('E2B_API_KEY disappeared during the live composition test')
    await expect(Sandbox.getInfo(String(output.sandboxId), { apiKey })).rejects.toBeInstanceOf(SandboxNotFoundError)
  }, 105_000)
})
