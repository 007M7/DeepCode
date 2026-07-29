import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { ResolveFnOutput, ResolveHookContext } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initialize, resolveHook, TsconfigPathsResolver } from '../src/tsconfig-paths-loader.ts'

class ResolverFixture {
  readonly root = mkdtempSync(join(tmpdir(), 'dsh-tsconfig-paths-'))

  path(relativePath: string): string {
    return join(this.root, relativePath)
  }

  write(relativePath: string, content = 'export {}\n'): string {
    const path = this.path(relativePath)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
    return path
  }

  writeJson(relativePath: string, value: unknown): string {
    return this.write(relativePath, `${JSON.stringify(value)}\n`)
  }

  createResolver(paths: Record<string, string[]>): TsconfigPathsResolver {
    const tsconfigPath = this.writeJson('tsconfig.json', { compilerOptions: { paths } })
    return TsconfigPathsResolver.create(tsconfigPath)
  }

  parentURL(relativePath = 'consumer/src/nested/index.ts'): string {
    return pathToFileURL(this.path(relativePath)).href
  }

  dispose(): void {
    rmSync(this.root, { recursive: true, force: true })
  }
}

const fixtures: ResolverFixture[] = []

function fixture(): ResolverFixture {
  const value = new ResolverFixture()
  fixtures.push(value)
  return value
}

afterEach(() => {
  for (const value of fixtures.splice(0)) value.dispose()
})

describe('TsconfigPathsResolver', () => {
  it('orders exact, longer-prefix, and longer-suffix path rules', async () => {
    const files = fixture()
    files.writeJson('consumer/package.json', {
      dependencies: {
        '@scope/feature-name': '*',
        '@scope/feature-other': '*',
        '@scope/plain-suffix': '*',
      },
    })
    files.write('targets/exact.ts')
    files.write('targets/prefix/other.ts')
    files.write('targets/generic/feature-other.ts')
    files.write('targets/suffix/plain.ts')
    files.write('targets/generic/plain-suffix.ts')
    const resolver = files.createResolver({
      '@scope/*': ['./targets/generic/*'],
      '@scope/*-suffix': ['./targets/suffix/*'],
      '@scope/feature-*': ['./targets/prefix/*'],
      '@scope/feature-name': ['./targets/exact.ts'],
    })

    await expect(resolver.resolve('@scope/feature-name', files.parentURL()))
      .resolves.toBe(pathToFileURL(files.path('targets/exact.ts')).href)
    await expect(resolver.resolve('@scope/feature-other', files.parentURL()))
      .resolves.toBe(pathToFileURL(files.path('targets/prefix/other.ts')).href)
    await expect(resolver.resolve('@scope/plain-suffix', files.parentURL()))
      .resolves.toBe(pathToFileURL(files.path('targets/suffix/plain.ts')).href)
  })

  it('resolves only self-references and runtime dependencies from the nearest ancestor manifest', async () => {
    const files = fixture()
    files.writeJson('consumer/package.json', {
      name: 'self-package',
      dependencies: { dependency: '*' },
      optionalDependencies: { optional: '*' },
      peerDependencies: { peer: '*' },
    })
    for (const name of ['self-package', 'dependency', 'optional', 'peer', 'undeclared']) {
      files.write(`targets/${name}.ts`)
    }
    const resolver = files.createResolver(Object.fromEntries(
      ['self-package', 'dependency', 'optional', 'peer', 'undeclared']
        .map(name => [name, [`./targets/${name}`]]),
    ))

    for (const name of ['self-package', 'dependency', 'optional', 'peer']) {
      await expect(resolver.resolve(name, files.parentURL()))
        .resolves.toBe(pathToFileURL(files.path(`targets/${name}.ts`)).href)
    }
    await expect(resolver.resolve('undeclared', files.parentURL())).resolves.toBeUndefined()
  })

  it('probes native TypeScript extensions and index files but excludes TSX and missing targets', async () => {
    const files = fixture()
    const names = ['plain-ts', 'module-mts', 'common-cts', 'directory', 'tsx-implicit', 'tsx-explicit', 'missing']
    files.writeJson('consumer/package.json', {
      dependencies: Object.fromEntries(names.map(name => [name, '*'])),
    })
    files.write('targets/plain.ts')
    files.write('targets/module.mts')
    files.write('targets/common.cts')
    files.write('targets/directory/index.ts')
    files.write('targets/component.tsx')
    const resolver = files.createResolver({
      'plain-ts': ['./targets/plain'],
      'module-mts': ['./targets/module'],
      'common-cts': ['./targets/common'],
      'directory': ['./targets/directory'],
      'tsx-implicit': ['./targets/component'],
      'tsx-explicit': ['./targets/component.tsx'],
      'missing': ['./targets/missing'],
    })

    for (const [name, target] of [
      ['plain-ts', 'targets/plain.ts'],
      ['module-mts', 'targets/module.mts'],
      ['common-cts', 'targets/common.cts'],
      ['directory', 'targets/directory/index.ts'],
    ] as const) {
      await expect(resolver.resolve(name, files.parentURL()))
        .resolves.toBe(pathToFileURL(files.path(target)).href)
    }
    await expect(resolver.resolve('tsx-implicit', files.parentURL())).resolves.toBeUndefined()
    await expect(resolver.resolve('tsx-explicit', files.parentURL())).resolves.toBeUndefined()
    await expect(resolver.resolve('missing', files.parentURL())).resolves.toBeUndefined()
  })

  it('anchors inherited paths at the config that declared them', async () => {
    const files = fixture()
    files.writeJson('consumer/package.json', { dependencies: { custom: '*' } })
    files.write('targets/custom.ts')
    files.writeJson('base.json', { compilerOptions: { paths: { custom: ['./targets/custom'] } } })
    const customTsconfig = files.writeJson('configs/custom.json', { extends: '../base.json' })
    const resolver = TsconfigPathsResolver.create(customTsconfig)

    await expect(resolver.resolve('custom', files.parentURL()))
      .resolves.toBe(pathToFileURL(files.path('targets/custom.ts')).href)
  })

  it('short-circuits matched aliases and delegates unsupported schemes or unmatched requests', async () => {
    const files = fixture()
    files.writeJson('consumer/package.json', { dependencies: { matched: '*' } })
    const target = files.write('targets/matched.ts')
    const tsconfigPath = files.writeJson('tsconfig.json', {
      compilerOptions: { paths: { matched: ['./targets/matched'] } },
    })
    initialize({ tsconfigPath })
    const context: ResolveHookContext = {
      conditions: [],
      importAttributes: {},
      parentURL: files.parentURL(),
    }
    const nextResolve = vi.fn(async (
      specifier: string,
      _context: ResolveHookContext,
    ): Promise<ResolveFnOutput> => ({ url: `next:${specifier}` }))

    await expect(resolveHook('matched', context, nextResolve))
      .resolves.toEqual({ url: pathToFileURL(target).href, shortCircuit: true })
    expect(nextResolve).not.toHaveBeenCalled()

    for (const specifier of ['unmatched', 'node:fs', 'data:text/javascript,export default 1', 'https://example.test/mod.ts']) {
      await expect(resolveHook(specifier, context, nextResolve)).resolves.toEqual({ url: `next:${specifier}` })
      expect(nextResolve).toHaveBeenLastCalledWith(specifier, context)
    }
  })
})
