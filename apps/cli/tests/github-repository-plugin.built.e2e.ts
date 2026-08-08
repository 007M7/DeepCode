import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
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
  it('installs, builds, and runs skill, MCP, and TypeScript Plugin contributions from a private exact GitHub source', async () => {
    expect(existsSync(dshBin), 'the repository Plugin acceptance must run the built dsh entry').toBe(true)
    expect(source, 'DSH_GITHUB_REPOSITORY_PLUGIN_SOURCE is required by this CI lane').toMatch(
      /^github:[^/\s#&]+\/[^/\s#&]+#[0-9a-f]{40}&path:\/.*\/\.dsh-plugin$/u,
    )

    const apiKey = 'github-repository-plugin-e2e-key'
    const server = await startMockLlmServer({
      sequence: ['tool_call_success', 'success'],
      apiKey,
      toolName: 'mcp__github_repository__proof',
      toolArguments: '{}',
      successText: 'trusted GitHub repository package reached dsh run',
    })
    const home = mkdtempSync(join(tmpdir(), 'dsh-github-repository-plugin-'))
    const patch = join(home, 'github-repository-plugin.cordis.patch.yml')
    writeFileSync(patch, [
      '- id: repository-plugins',
      '  config:',
      '    repositories:',
      `      - ${JSON.stringify(source)}`,
      '- id: session-title-llm',
      '  disabled: true',
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
        timeout: 180_000,
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
        throw new Error(`dsh GitHub repository Plugin run did not exit within 180s. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
      }
      expect(result.exitCode, `${result.stderr}\nstdout:\n${result.stdout}`).toBe(0)
      expect(result.stdout).toBe('trusted GitHub repository package reached dsh run')
      expect(server.requests).toHaveLength(2)
      const runtimeDiagnostic = `${result.stderr}\nstdout:\n${result.stdout}`
      const firstRequest = JSON.stringify(server.requests[0]!.body)
      const secondRequest = JSON.stringify(server.requests[1]!.body)
      expect(firstRequest, runtimeDiagnostic).toContain(
        'Proves that dsh installed a private repository Plugin from an exact GitHub source.',
      )
      expect(firstRequest, runtimeDiagnostic).toContain('mcp__github_repository__proof')
      expect(firstRequest, runtimeDiagnostic).toContain('Proves that an MCP server compiled from the exact GitHub repository package is active.')
      expect(secondRequest, runtimeDiagnostic).toContain('MCP_FROM_GITHUB_REPOSITORY')
      expect(secondRequest, runtimeDiagnostic).toContain('TS_PLUGIN_FROM_GITHUB_REPOSITORY')

      const cacheRoot = join(home, 'cache', 'repository-plugins')
      const generations = readdirSync(cacheRoot, { withFileTypes: true }).filter(entry => entry.isDirectory())
      expect(generations).toHaveLength(1)
      const installed = join(cacheRoot, generations[0]!.name, 'node_modules', 'repository')
      const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')) as Record<string, unknown>
      expect(manifest).toMatchObject({
        name: 'dsh-github-repository-plugin-e2e-fixture',
        private: true,
        scripts: {
          prepack: 'tsc --noEmit && tsdown src/plugin.ts src/mcp-server.ts --no-config --tsconfig tsconfig.json --out-dir lib --platform node --target es2024 --clean && dsh-plugin-prepare',
        },
        dsh: {
          skills: ['../skills'],
          mcpServers: './.mcp.json',
          entry: './lib/plugin.mjs',
        },
        dependencies: {
          '@modelcontextprotocol/sdk': '1.29.0',
        },
        devDependencies: {
          cordis: '4.0.0-rc.7',
          tsdown: '0.22.2',
          typescript: '6.0.3',
        },
      })
      expect(readFileSync(join(installed, 'dsh-plugin-assets/skills/0/github-source-proof/SKILL.md'), 'utf8'))
        .toContain('This skill exists only in the GitHub repository source fixture.')
      expect(readFileSync(join(installed, 'dsh-plugin-assets/.mcp.json'), 'utf8')).toContain('lib/mcp-server.mjs')
      expect(readFileSync(join(installed, 'lib/plugin.mjs'), 'utf8')).toContain('TS_PLUGIN_FROM_GITHUB_REPOSITORY')
      expect(readFileSync(join(installed, 'lib/mcp-server.mjs'), 'utf8')).toContain('MCP_FROM_GITHUB_REPOSITORY')
      expect(existsSync(join(installed, 'src'))).toBe(false)
      const installedRequire = createRequire(join(installed, 'lib/mcp-server.mjs'))
      expect(existsSync(installedRequire.resolve('@modelcontextprotocol/sdk/server/mcp.js'))).toBe(true)
      const wrapper = readFileSync(join(installed, 'dsh-plugin.mjs'), 'utf8')
      expect(wrapper).toContain('dsh-repository-plugin')
      expect(wrapper).toContain('await import(manifest.entry)')
      expect(wrapper).toContain('"entry":"./lib/plugin.mjs"')
    } finally {
      await server.close()
      rmSync(home, { recursive: true, force: true })
    }
  }, 190_000)
})
