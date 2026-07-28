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
  it('runs FS, Bash, PTY, LSP, and Code Runtime in one sandbox and deletes it', async () => {
    const { stdout, stderr } = await runLoaderSmoke({
      label: 'E2B composition',
      tempDirPrefix: 'dsh-e2b-composition-',
      binScript,
      libBinScript: binScript,
      configPath,
      tsconfigPath,
      env: {
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
      },
      processTimeoutMs: 120_000,
      inspect: async (cwd) => {
        for (const name of ['from-fs.txt', 'from-bash.txt', 'multibyte # file.ts', 'fixture-lsp.mjs']) {
          await expect(access(join(cwd, name))).rejects.toMatchObject({ code: 'ENOENT' })
        }
      },
    })

    expect(stderr).toBe('')
    const output = JSON.parse(stdout) as Record<string, unknown>
    expect(output).toMatchObject({
      bashRead: 'written-by-fs\n',
      fsRead: 'written-by-bash\n',
      explicitEnvironment: true,
      spill: {
        liveBytes: 6,
        outcome: { exitCode: null, signal: 'SIGTERM' },
        read: { text: '6789', nextOffset: 10, lossy: true },
      },
      hover: {
        kind: 'hover',
        hover: { contents: '**remote hover** 你好 café' },
      },
      definition: {
        kind: 'locations',
        locations: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 10 } } }],
      },
      terminal: {
        echo: { waitReason: 'stdin_read', sessionStatus: { kind: 'running' } },
        signal: { delivered: true },
        interrupted: { sessionStatus: { kind: 'running' } },
      },
      hostileOutput: { error: { kind: 'output-limit' } },
      timedOut: { error: { kind: 'timeout' } },
      aborted: { error: { kind: 'abort', message: 'live abort' } },
      oversizedBoot: { error: { kind: 'worker-exit' } },
      oversizedReply: { error: { kind: 'worker-exit' } },
      lingeringCodeRunners: 0,
    })
    expect((output.terminal as { motd: string }).motd.length).toBeGreaterThan(0)
    expect((output.terminal as { echo: { viewport: string } }).echo.viewport).toContain('PTY-你好')
    expect((output.terminal as { scrollback: string }).scrollback).toContain('PTY-你好')
    expect((output.terminal as { signal: { targetPgid: number } }).signal.targetPgid).toBeGreaterThan(0)
    expect(['stdin_read', 'inferred_idle']).toContain(
      (output.terminal as { interrupted: { waitReason: string } }).interrupted.waitReason,
    )
    expect(output.code).toEqual({
      value: { doubled: 42, typed: true },
      logs: ['remote-log 你好 42', 'post-mutation'],
    })
    const apiKey = process.env.E2B_API_KEY
    if (apiKey === undefined) throw new Error('E2B_API_KEY disappeared during the live composition test')
    await expect(Sandbox.getInfo(String(output.sandboxId), { apiKey })).rejects.toBeInstanceOf(SandboxNotFoundError)
  }, 135_000)
})
