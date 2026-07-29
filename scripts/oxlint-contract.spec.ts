import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const eslintCli = fileURLToPath(new URL('../node_modules/eslint/bin/eslint.js', import.meta.url))
const oxlintCli = fileURLToPath(new URL('../node_modules/oxlint/bin/oxlint', import.meta.url))

function runStagedFormatter(paths: readonly string[]) {
  return spawnSync(process.execPath, [eslintCli, '--config', 'eslint.format.config.mjs', '--fix', '--no-warn-ignored', ...paths], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  })
}

function runOxlint(args: readonly string[]) {
  return spawnSync(process.execPath, [oxlintCli, ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  })
}

function normalizedOutput(result: ReturnType<typeof runOxlint>): string {
  return `${result.stdout}${result.stderr}`.replaceAll('\\', '/')
}

async function writeContractConfig(suffix: string): Promise<string> {
  const path = join(repositoryRoot, `.oxlintrc.contract-${suffix}.json`)
  await writeFile(path, JSON.stringify({ extends: ['./.oxlintrc.json'], ignorePatterns: [] }))
  return path
}

describe('Oxlint executable contract', () => {
  it('runs type-aware rules for every owned TypeScript file class', async () => {
    const suffix = randomUUID()
    const configPath = await writeContractConfig(suffix)
    const probes = [
      ['host package source', 'packages/fs/fs-policy/src', 'host-source.ts'],
      ['host package test', 'packages/fs/fs-policy/tests', 'host-test.spec.ts'],
      ['client package source', 'packages/client/ui-primitives/src', 'client-source.ts'],
      ['client package test', 'packages/client/ui-trajectory/tests', 'client-test.spec.ts'],
      ['client aggregate script', 'scripts', 'client-bundle-purity.spec.ts'],
      ['example', 'examples', 'example.ts'],
      ['website', 'website', 'website.ts'],
    ] as const
    const directories: string[] = []
    const source = `function probePromise(): Promise<void> {
  return Promise.resolve()
}

probePromise()
`

    try {
      const paths: Array<readonly [label: string, path: string]> = []
      for (const [label, parent, filename] of probes) {
        const directory = join(repositoryRoot, parent, `.oxlint-contract-${suffix}`)
        directories.push(directory)
        await mkdir(directory, { recursive: true })
        const path = join(directory, filename)
        await writeFile(path, source)
        paths.push([label, relative(repositoryRoot, path)])
      }

      const result = runOxlint([
        '--config',
        relative(repositoryRoot, configPath),
        '--format',
        'unix',
        ...paths.map(([, path]) => path),
      ])
      const output = normalizedOutput(result)

      expect(result.error).toBeUndefined()
      expect(result.status, output).toBe(1)
      for (const [label, path] of paths) {
        expect(output, label).toContain(`${path.replaceAll('\\', '/')}:5:1: Promises must be awaited`)
      }
      expect(output.match(/typescript\(no-floating-promises\)/g)).toHaveLength(probes.length)
    } finally {
      await Promise.all([
        ...directories.map(directory => rm(directory, { recursive: true, force: true })),
        rm(configPath, { force: true }),
      ])
    }
  }, 20_000)

  it('applies staged stylistic fixes before Oxlint validation', async () => {
    const suffix = randomUUID()
    const configPath = await writeContractConfig(suffix)
    const directory = join(repositoryRoot, 'scripts', `.oxlint-contract-${suffix}`)
    const path = join(directory, 'fix.ts')

    try {
      await mkdir(directory, { recursive: true })
      await writeFile(path, 'const value={answer:1};  \nconsole.log(value)\n')

      const relativePath = relative(repositoryRoot, path)
      const formatResult = runStagedFormatter([relativePath])
      const lintResult = runOxlint(['--config', relative(repositoryRoot, configPath), '--fix', relativePath])

      expect(formatResult.error).toBeUndefined()
      expect(formatResult.status, normalizedOutput(formatResult)).toBe(0)
      expect(lintResult.error).toBeUndefined()
      expect(lintResult.status, normalizedOutput(lintResult)).toBe(0)
      await expect(readFile(path, 'utf8')).resolves.toBe('const value={ answer:1 }\nconsole.log(value)\n')
    } finally {
      await Promise.all([
        rm(directory, { recursive: true, force: true }),
        rm(configPath, { force: true }),
      ])
    }
  }, 20_000)
})
