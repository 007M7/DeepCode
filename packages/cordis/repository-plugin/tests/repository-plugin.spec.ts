import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import { RepositoryCache } from '@cordisjs/plugin-loader/repository'
import SkillService from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import InvariantService from '@deepseek-ai/dsh-invariants'
import * as RepositoryPlugin from '@deepseek-ai/dsh-repository-plugin'
import * as RepositoryPluginInvariant from '@deepseek-ai/dsh-repository-plugin/invariant'
import { parsePreparedPluginConfig } from '../src/format.ts'
import {
  loadPreparedRepository,
  resolveRepositoryCacheDirectory,
  resolveRepositorySpecifier,
} from '../src/source.ts'

const roots: string[] = []

async function temporaryDirectory(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `dsh-repository-plugin-${name}-`))
  roots.push(directory)
  return directory
}

async function writePlugin(root: string, name: string, dsh: Record<string, unknown>): Promise<string> {
  const directory = join(root, '.dsh-plugin')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'package.json'), `${JSON.stringify({ name, version: '0.0.0', dsh }, undefined, 2)}\n`)
  return directory
}

async function writeSkill(root: string, name: string): Promise<void> {
  const directory = join(root, name)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Repository fixture skill.\n---\n\nStatic instructions.\n`)
}

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('dsh-plugin-prepare', () => {
  it('copies declared static assets and emits the fixed import-free wrapper', async () => {
    const root = await temporaryDirectory('prepare')
    await writeSkill(join(root, 'skills'), 'repository-fixture')
    await writeFile(join(root, '.mcp.json'), JSON.stringify({
      mcpServers: {
        expo: { type: 'http', url: 'https://mcp.expo.dev/mcp' },
      },
    }))
    const directory = await writePlugin(root, 'fixture-plugin', {
      skills: ['../skills'],
      mcpServers: '../.mcp.json',
    })

    await expect(RepositoryPlugin.prepareDshPlugin(directory)).resolves.toEqual({
      name: 'fixture-plugin',
      skills: ['dsh-plugin-assets/skills/0'],
      mcpServers: 'dsh-plugin-assets/.mcp.json',
    })
    const wrapper = await readFile(join(directory, RepositoryPlugin.PREPARED_ENTRY_FILENAME), 'utf8')
    expect(wrapper).toContain(`ctx.loader.builtins["${RepositoryPlugin.REPOSITORY_PLUGIN_BUILTIN}"]`)
    // Import-free means no static AND no dynamic imports; `import.meta.url`
    // (no whitespace, no call parenthesis) is the one allowed appearance.
    expect(wrapper).not.toMatch(/\b(?:import|from)\s|\bimport\s*\(/)
    await expect(readFile(join(directory, 'dsh-plugin-assets/skills/0/repository-fixture/SKILL.md'), 'utf8'))
      .resolves.toContain('Static instructions.')
    await expect(readFile(join(directory, 'dsh-plugin-assets/.mcp.json'), 'utf8'))
      .resolves.toContain('mcp.expo.dev')
  })

  it('rejects unsupported OAuth MCP metadata before publishing outputs', async () => {
    const root = await temporaryDirectory('oauth')
    await writeFile(join(root, '.mcp.json'), JSON.stringify({
      mcpServers: {
        workiq: {
          type: 'http',
          url: 'https://workiq.microsoft.com/mcp',
          oauthClientId: 'client-id',
          oauthPublicClient: true,
          auth: { redirectPort: 3317 },
        },
      },
    }))
    const directory = await writePlugin(root, 'unsupported-oauth', { mcpServers: '../.mcp.json' })

    await expect(RepositoryPlugin.prepareDshPlugin(directory)).rejects.toThrow('invalid .mcp.json')
    await expect(readFile(join(directory, RepositoryPlugin.PREPARED_ENTRY_FILENAME), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects invalid metadata, missing assets, wrong asset types, and escaped paths', async () => {
    const malformedRoot = await temporaryDirectory('malformed-package')
    const malformed = join(malformedRoot, '.dsh-plugin')
    await mkdir(malformed)
    await writeFile(join(malformed, 'package.json'), '{')
    await expect(RepositoryPlugin.prepareDshPlugin(malformed)).rejects.toThrow('failed to read DSH plugin package metadata')

    const emptyRoot = await temporaryDirectory('empty-metadata')
    const empty = await writePlugin(emptyRoot, 'empty', {})
    await expect(RepositoryPlugin.prepareDshPlugin(empty)).rejects.toThrow('declare at least one skill root or mcpServers file')

    const missingRoot = await temporaryDirectory('missing-asset')
    const missing = await writePlugin(missingRoot, 'missing', { skills: ['../missing'] })
    await expect(RepositoryPlugin.prepareDshPlugin(missing)).rejects.toThrow('asset does not exist')

    const absoluteRoot = await temporaryDirectory('absolute-asset')
    const absolute = await writePlugin(absoluteRoot, 'absolute', { skills: [absoluteRoot] })
    await expect(RepositoryPlugin.prepareDshPlugin(absolute)).rejects.toThrow('asset path must be relative')

    const wrongTypeRoot = await temporaryDirectory('wrong-type')
    await writeFile(join(wrongTypeRoot, 'not-a-directory'), 'text')
    const wrongType = await writePlugin(wrongTypeRoot, 'wrong-type', { skills: ['../not-a-directory'] })
    await expect(RepositoryPlugin.prepareDshPlugin(wrongType)).rejects.toThrow('asset is not a directory')

    const wrongMcpRoot = await temporaryDirectory('wrong-mcp-type')
    await mkdir(join(wrongMcpRoot, 'not-a-file'))
    const wrongMcp = await writePlugin(wrongMcpRoot, 'wrong-mcp', { mcpServers: '../not-a-file' })
    await expect(RepositoryPlugin.prepareDshPlugin(wrongMcp)).rejects.toThrow('asset is not a file')

    const containingRoot = await temporaryDirectory('containing-root')
    const containing = await writePlugin(containingRoot, 'containing', { skills: ['..'] })
    await expect(RepositoryPlugin.prepareDshPlugin(containing)).rejects.toThrow('cannot contain the .dsh-plugin package')

    const escapedRoot = await temporaryDirectory('escaped-root')
    const outside = await temporaryDirectory('outside-root')
    await writeSkill(outside, 'outside-skill')
    const escaped = await writePlugin(escapedRoot, 'escaped', { skills: [relative(join(escapedRoot, '.dsh-plugin'), outside)] })
    await expect(RepositoryPlugin.prepareDshPlugin(escaped)).rejects.toThrow('escapes its plugin source root')
  })

  it('validates prepared wrapper configs with and without MCP assets', () => {
    expect(() => parsePreparedPluginConfig({})).toThrow('invalid prepared DSH plugin')
    expect(parsePreparedPluginConfig({
      baseUrl: 'file:///plugin/dsh-plugin.mjs',
      manifest: { name: 'fixture', skills: [], mcpServers: 'dsh-plugin-assets/.mcp.json' },
    })).toEqual({
      baseUrl: 'file:///plugin/dsh-plugin.mjs',
      manifest: { name: 'fixture', skills: [], mcpServers: 'dsh-plugin-assets/.mcp.json' },
    })
  })
})

describe('prepared repository plugin Loader composition', () => {
  it('mounts and removes copied skills through the real Loader and skill-local provider', async () => {
    const root = await temporaryDirectory('loader')
    await writeSkill(join(root, 'skills'), 'loaded-from-repository')
    const directory = await writePlugin(root, 'loader-fixture', { skills: ['../skills'] })
    await RepositoryPlugin.prepareDshPlugin(directory)

    const ctx = new Context()
    ctx.baseUrl = pathToFileURL(directory).href + '/'
    await ctx.plugin(Loader)
    await ctx.plugin(SkillService)
    const registrar = ctx.plugin(RepositoryPlugin)
    await registrar
    expect(ctx.loader.builtins[RepositoryPlugin.REPOSITORY_PLUGIN_BUILTIN]).toBeDefined()

    const id = await ctx.loader.create({
      name: pathToFileURL(join(directory, RepositoryPlugin.PREPARED_ENTRY_FILENAME)).href,
    })
    await ctx.loader.await()
    await expect(ctx.skills.get('loaded-from-repository')).resolves.toMatchObject({
      name: 'loaded-from-repository',
      provider: 'repository:loader-fixture',
      content: 'Static instructions.',
    })

    await ctx.loader.remove(id)
    await expect(ctx.skills.get('loaded-from-repository')).resolves.toBeUndefined()
    await registrar.dispose()
    expect(ctx.loader.builtins[RepositoryPlugin.REPOSITORY_PLUGIN_BUILTIN]).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('delegates an MCP-only plugin to the existing client without turning connect failure into Loader failure', async () => {
    const root = await temporaryDirectory('mcp-loader')
    await writeFile(join(root, '.mcp.json'), JSON.stringify({
      mcpServers: { offline: { command: join(root, 'missing-mcp-command') } },
    }))
    const directory = await writePlugin(root, 'mcp-loader-fixture', { mcpServers: '../.mcp.json' })
    await RepositoryPlugin.prepareDshPlugin(directory)

    const ctx = new Context()
    ctx.baseUrl = pathToFileURL(directory).href + '/'
    await ctx.plugin(Loader)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(RepositoryPlugin)
    const id = await ctx.loader.create({
      name: pathToFileURL(join(directory, RepositoryPlugin.PREPARED_ENTRY_FILENAME)).href,
    })
    await ctx.loader.await()
    expect(ctx.tools.schemas().some(tool => tool.name.startsWith('mcp__offline__'))).toBe(false)
    await ctx.loader.remove(id)
    await ctx.fiber.dispose()
  })

  it('rejects hostile prepared paths before mounting children', async () => {
    const root = await temporaryDirectory('prepared-paths')
    const ctx = new Context()
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    await ctx.plugin(RepositoryPlugin)

    for (const [filename, skillPath] of [
      ['absolute.mjs', resolve(root)],
      ['escaped.mjs', '../outside'],
    ] as const) {
      const wrapper = join(root, filename)
      await writeFile(wrapper, [
        "export const inject = ['loader']",
        'export async function apply(ctx) {',
        `  await ctx.plugin(ctx.loader.builtins['${RepositoryPlugin.REPOSITORY_PLUGIN_BUILTIN}'], {`,
        `    baseUrl: import.meta.url, manifest: { name: 'hostile', skills: [${JSON.stringify(skillPath)}] },`,
        '  })',
        '}',
        '',
      ].join('\n'))
      await expect(ctx.loader.create({ name: pathToFileURL(wrapper).href })).rejects.toThrow('prepared DSH plugin path')
    }
    await ctx.fiber.dispose()
  })

  it('fails the plugin load when a declared skill root is missing or not a directory', async () => {
    const root = await temporaryDirectory('missing-skill-root')
    await writeFile(join(root, 'not-a-directory'), 'text')
    const ctx = new Context()
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    await ctx.plugin(SkillService)
    await ctx.plugin(RepositoryPlugin)

    for (const [filename, skillPath, message] of [
      ['missing.mjs', 'dsh-plugin-assets/skills/0', 'skill root is missing from the installed package'],
      ['file.mjs', 'not-a-directory', 'skill root is not a directory'],
    ] as const) {
      const wrapper = join(root, filename)
      await writeFile(wrapper, [
        "export const inject = ['loader']",
        'export async function apply(ctx) {',
        `  await ctx.plugin(ctx.loader.builtins['${RepositoryPlugin.REPOSITORY_PLUGIN_BUILTIN}'], {`,
        `    baseUrl: import.meta.url, manifest: { name: 'damaged', skills: [${JSON.stringify(skillPath)}] },`,
        '  })',
        '}',
        '',
      ].join('\n'))
      await expect(ctx.loader.create({ name: pathToFileURL(wrapper).href })).rejects.toThrow(message)
    }
    await ctx.fiber.dispose()
  })

  it('rejects duplicate builtin ownership and preserves a later replacement on teardown', async () => {
    const ctx = new Context()
    await ctx.plugin(Loader)
    const registrar = ctx.plugin(RepositoryPlugin)
    await registrar
    await expect(RepositoryPlugin.apply(ctx)).rejects.toThrow('already registered')

    const replacement = { name: 'replacement', apply() {} }
    ctx.loader.builtins[RepositoryPlugin.REPOSITORY_PLUGIN_BUILTIN] = replacement
    await registrar.dispose()
    expect(ctx.loader.builtins[RepositoryPlugin.REPOSITORY_PLUGIN_BUILTIN]).toBe(replacement)
    await ctx.fiber.dispose()
  })
})

describe('configured GitHub repository sources', () => {
  it('defaults an omitted source list and rejects unknown configuration fields', () => {
    expect(RepositoryPlugin.Config.parse(undefined)).toEqual({ repositories: [] })
    expect(RepositoryPlugin.Config.safeParse({ repositories: [], unexpected: true }).success).toBe(false)
  })

  it('accepts an empty direct-apply config', async () => {
    const ctx = new Context()
    await ctx.plugin(Loader)
    await RepositoryPlugin.apply(ctx, {})
    expect(ctx.loader.builtins[RepositoryPlugin.REPOSITORY_PLUGIN_BUILTIN]).toBeDefined()
    await ctx.fiber.dispose()
  })

  it('adds the root plugin subpath and preserves an explicit nested plugin subpath', () => {
    expect(resolveRepositorySpecifier('github:PolyArch/humanize#v1.0.0'))
      .toBe('github:PolyArch/humanize#v1.0.0&path:/.dsh-plugin')
    expect(resolveRepositorySpecifier('github:owner/repository#feature/ref&path:/plugins/one/.dsh-plugin'))
      .toBe('github:owner/repository#feature/ref&path:/plugins/one/.dsh-plugin')
  })

  it('rejects absent refs and invalid plugin subpaths', () => {
    for (const source of [
      'github:owner/repository',
      'github:owner/repository#',
      'https://github.com/owner/repository#ref',
      'github:owner/repository#ref&path:relative/.dsh-plugin',
    ]) {
      expect(() => resolveRepositorySpecifier(source)).toThrow('must use github:owner/repo#<ref>')
    }
    for (const path of [
      '/plugins//.dsh-plugin',
      '/plugins/../.dsh-plugin',
      '/plugins/./.dsh-plugin',
      '/plugins/not-a-plugin',
    ]) {
      expect(() => resolveRepositorySpecifier(`github:owner/repository#ref&path:${path}`))
        .toThrow('path must be an absolute repository subpath')
    }
  })

  it('resolves the default cache under DSH_HOME and an explicit cache absolutely', async () => {
    const root = await temporaryDirectory('cache-root')
    vi.stubEnv('DSH_HOME', root)
    expect(resolveRepositoryCacheDirectory(undefined)).toBe(join(root, 'cache', 'repository-plugins'))
    expect(resolveRepositoryCacheDirectory(join(root, 'explicit'))).toBe(join(root, 'explicit'))
  })

  it('loads a configured source through the immutable cache and removes its skill on teardown', async () => {
    const root = await temporaryDirectory('configured-source')
    await writeSkill(join(root, 'skills'), 'configured-repository-skill')
    const directory = await writePlugin(root, 'configured-source-fixture', { skills: ['../skills'] })
    await RepositoryPlugin.prepareDshPlugin(directory)
    const resolved: string[] = []
    const cacheDirectory = join(root, 'cache')
    vi.spyOn(RepositoryCache.prototype, 'resolve').mockImplementation(async function (this: RepositoryCache, specifier) {
      expect(this.directory).toBe(cacheDirectory)
      resolved.push(specifier)
      return directory
    })

    const ctx = new Context()
    await ctx.plugin(Loader)
    await ctx.plugin(SkillService)
    const registrar = ctx.plugin(RepositoryPlugin, {
      repositories: ['github:owner/repository#fixed-ref'],
      cacheDir: cacheDirectory,
    })
    await registrar
    expect(resolved).toEqual(['github:owner/repository#fixed-ref&path:/.dsh-plugin'])
    await expect(ctx.skills.get('configured-repository-skill')).resolves.toMatchObject({
      provider: 'repository:configured-source-fixture',
    })

    await registrar.dispose()
    await expect(ctx.skills.get('configured-repository-skill')).resolves.toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('rejects duplicate generations and cleans the builtin after cache preparation fails', async () => {
    const ctx = new Context()
    await ctx.plugin(Loader)
    await expect(RepositoryPlugin.apply(ctx, {
      repositories: [
        'github:owner/repository#ref',
        'github:owner/repository#ref',
      ],
    })).rejects.toThrow('must resolve to unique exact specifiers')

    vi.spyOn(RepositoryCache.prototype, 'resolve').mockRejectedValue(new Error('prepare failed'))
    await expect(RepositoryPlugin.apply(ctx, {
      repositories: ['github:owner/repository#other'],
    })).rejects.toThrow('prepare failed')
    expect(ctx.loader.builtins[RepositoryPlugin.REPOSITORY_PLUGIN_BUILTIN]).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('labels a missing prepared wrapper with its exact source and path', async () => {
    const root = await temporaryDirectory('missing-wrapper')
    const ctx = new Context()
    const specifier = 'github:owner/repository#missing&path:/.dsh-plugin'
    await expect(loadPreparedRepository(ctx, { resolve: async () => root }, specifier))
      .rejects.toThrow(`failed to load prepared repository Plugin ${JSON.stringify(specifier)}`)
    await ctx.fiber.dispose()
  })
})

describe('repository plugin invariant companion', () => {
  it('registers its explained empty invariant', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantService, { enabled: true })
    await expect(ctx.plugin(RepositoryPluginInvariant).await()).resolves.toBeDefined()
    await ctx.fiber.dispose()
  })
})
