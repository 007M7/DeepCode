import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const dshBin = join(repoRoot, 'apps/cli/lib/bin.js')
const source = process.env.DSH_GITHUB_REPOSITORY_PLUGIN_SOURCE
const required = process.env.DSH_REQUIRE_GITHUB_REPOSITORY_PLUGIN_E2E === '1'
const enabled = required || source !== undefined

describe.skipIf(!enabled)('dsh run GitHub repository Plugin installation', () => {
  it('installs a private exact GitHub source and exposes its skill to the model', async () => {
    expect(existsSync(dshBin), 'the repository Plugin acceptance must run the built dsh entry').toBe(true)
    expect(source, 'DSH_GITHUB_REPOSITORY_PLUGIN_SOURCE is required by this CI lane').toMatch(
      /^github:[^/\s#&]+\/[^/\s#&]+#[0-9a-f]{40}&path:\/.*\/\.dsh-plugin$/u,
    )

    const apiKey = 'github-repository-plugin-e2e-key'
    const server = await startMockLlmServer({
      sequence: ['success'],
      apiKey,
      successText: 'private GitHub repository Plugin reached dsh run',
    })
    const home = mkdtempSync(join(tmpdir(), 'dsh-github-repository-plugin-'))
    const patch = join(home, 'github-repository-plugin.cordis.patch.yml')
    writeFileSync(patch, [
      '- id: repository-plugins',
      '  config:',
      '    repositories:',
      `      - ${JSON.stringify(source)}`,
      '',
    ].join('\n'))

    try {
      const result = await execa(process.execPath, [
        dshBin,
        'run',
        '--patch',
        patch,
        'prove the private GitHub repository Plugin is active',
      ], {
        cwd: repoRoot,
        input: '',
        timeout: 120_000,
        killSignal: 'SIGKILL',
        reject: false,
        env: {
          ...process.env,
          DSH_HOME: home,
          DSH_TELEMETRY_DISABLED: '1',
          DEEPSEEK_API_KEY: apiKey,
          DEEPSEEK_BASE_URL: server.baseURL,
        },
      })
      if (result.timedOut) {
        throw new Error(`dsh GitHub repository Plugin run did not exit within 120s. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
      }
      expect(result.exitCode, `${result.stderr}\nstdout:\n${result.stdout}`).toBe(0)
      expect(result.stdout).toBe('private GitHub repository Plugin reached dsh run')
      expect(server.requests.length).toBeGreaterThan(0)
      expect(JSON.stringify(server.requests.map(request => request.body))).toContain(
        'Proves that dsh installed a private repository Plugin from an exact GitHub source.',
      )

      const cacheRoot = join(home, 'cache', 'repository-plugins')
      const generations = readdirSync(cacheRoot, { withFileTypes: true }).filter(entry => entry.isDirectory())
      expect(generations).toHaveLength(1)
      const installed = join(cacheRoot, generations[0]!.name, 'node_modules', 'repository')
      const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')) as Record<string, unknown>
      expect(manifest).toMatchObject({
        name: 'dsh-github-repository-plugin-e2e-fixture',
        private: true,
        scripts: { prepack: 'dsh-plugin-prepare' },
      })
      expect(manifest).not.toHaveProperty('dependencies')
      expect(manifest).not.toHaveProperty('devDependencies')
      expect(readFileSync(join(installed, 'dsh-plugin-assets/skills/0/github-source-proof/SKILL.md'), 'utf8'))
        .toContain('This skill exists only in the GitHub repository source fixture.')
      expect(readFileSync(join(installed, 'dsh-plugin.mjs'), 'utf8')).toContain('dsh-repository-plugin')
    } finally {
      await server.close()
      rmSync(home, { recursive: true, force: true })
    }
  }, 130_000)
})
