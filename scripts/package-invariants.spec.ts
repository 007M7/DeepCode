import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  collectPackageInvariantViolations,
} from './package-invariants.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function handwrittenInvariant(packageName: string): string {
  return `
export const name = 'probe-invariant'
export const inject = ['invariants']
const install = (_ctx: unknown, fail: (message: string) => never) => {
  if (typeof ${JSON.stringify(packageName)} !== 'string') fail('package name must remain a string')
}
export const apply = (ctx: { invariants: { register(name: string, install: typeof install): () => void } }) =>
  Promise.resolve(ctx.invariants.register(${JSON.stringify(packageName)}, install))
`
}

function fixture(options: {
  packageName?: string
  source?: string
  invariantExport?: boolean
  invariantDependency?: boolean
  invariantReference?: boolean
  buildEntry?: boolean
} = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-package-invariants-'))
  roots.push(root)
  const dir = join(root, 'packages/core/probe')
  mkdirSync(join(dir, 'src'), { recursive: true })
  const packageName = options.packageName ?? '@deepseek-ai/dsh-probe'
  const manifest = {
    name: packageName,
    exports: options.invariantExport === false ? {} : {
      './invariant': {
        types: './lib/types/invariant.d.ts',
        default: './lib/invariant.js',
      },
    },
    files: ['lib/index.js', 'lib/invariant.js', 'src'],
    peerDependencies: options.invariantDependency === false ? {} : {
      '@deepseek-ai/dsh-invariants': '^0.0.1',
    },
    devDependencies: options.invariantDependency === false ? {} : {
      '@deepseek-ai/dsh-invariants': 'workspace:^',
    },
  }
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(join(dir, 'tsconfig.json'), `${JSON.stringify({
    references: options.invariantReference === false ? [] : [{ path: '../../support/invariants' }],
  }, null, 2)}\n`)
  writeFileSync(join(dir, 'src/invariant.ts'), options.source ?? handwrittenInvariant(packageName))
  writeFileSync(
    join(dir, 'tsdown.config.ts'),
    options.buildEntry === false ? "export default { entry: ['lib/types/index.js'] }\n" : "export default { entry: ['lib/types/index.js', 'lib/types/invariant.js'] }\n",
  )
  return root
}

function addConformingPackage(root: string, slug: string, packageName: string, source: string): void {
  const dir = join(root, `packages/core/${slug}`)
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    name: packageName,
    exports: {
      './invariant': {
        types: './lib/types/invariant.d.ts',
        default: './lib/invariant.js',
      },
    },
    files: ['lib/invariant.js'],
    peerDependencies: { '@deepseek-ai/dsh-invariants': '^0.0.1' },
    devDependencies: { '@deepseek-ai/dsh-invariants': 'workspace:^' },
  }, null, 2)}\n`)
  writeFileSync(join(dir, 'tsconfig.json'), `${JSON.stringify({
    references: [{ path: '../../support/invariants' }],
  }, null, 2)}\n`)
  writeFileSync(join(dir, 'src/invariant.ts'), source)
  writeFileSync(join(dir, 'tsdown.config.ts'), "export default { entry: ['lib/types/invariant.js'] }\n")
}

function nameObservedInvariant(packageName: string, pluginName: string): string {
  return `
import { observePluginInvariant } from '@deepseek-ai/dsh-invariants'
export const name = 'probe-invariant'
export const inject = ['invariants']
const install = (ctx: never, fail: (message: string) => never) => {
  observePluginInvariant(ctx, fail, { name: ${JSON.stringify(pluginName)} })
}
export const apply = (ctx: { invariants: { register(name: string, install: typeof install): () => void } }) =>
  Promise.resolve(ctx.invariants.register(${JSON.stringify(packageName)}, install))
`
}

describe('package invariant gate', () => {
  it('accepts a hand-owned checking companion with publication metadata', () => {
    expect(collectPackageInvariantViolations(fixture())).toEqual([])
  })

  it('rejects missing publication metadata and build output', () => {
    const violations = collectPackageInvariantViolations(fixture({
      invariantExport: false,
      invariantDependency: false,
      invariantReference: false,
      buildEntry: false,
    }))
    expect(violations.map(violation => violation.message)).toEqual(expect.arrayContaining([
      expect.stringContaining('exports["./invariant"]'),
      expect.stringContaining('peerDependency'),
      expect.stringContaining('devDependency'),
      expect.stringContaining('TypeScript project references'),
      expect.stringContaining('must bundle lib/types/invariant.js'),
    ]))
  })

  it('rejects foreign, duplicate, and unresolved registrations', () => {
    const source = `
export const name = 'probe-invariant'
export const inject = ['invariants']
const selected = process.env.PACKAGE_NAME
const install = (_ctx: unknown, fail: (message: string) => never) => { fail('probe') }
export const apply = (ctx: { invariants: { register(name: string, install: typeof install): () => void } }) => {
  ctx.invariants.register('@deepseek-ai/dsh-foreign', install)
  return ctx.invariants.register(selected!, install)
}
`
    const violations = collectPackageInvariantViolations(fixture({ source }))
    expect(violations.map(violation => violation.message)).toEqual(expect.arrayContaining([
      expect.stringContaining('must resolve to a local string constant'),
      expect.stringContaining('must register exactly its own package name'),
    ]))
  })

  it('rejects generated markers and empty or reporter-free installers', () => {
    const generated = fixture({
      source: `/** @generated scripts/gen-package-invariants.ts */\n${handwrittenInvariant('@deepseek-ai/dsh-probe')}`,
    })
    expect(collectPackageInvariantViolations(generated).map(violation => violation.message))
      .toContain('invariant companions must be hand-owned and may not carry @generated markers')

    const empty = fixture({
      source: `
export const name = 'probe-invariant'
export const inject = ['invariants']
const install = () => {}
export const apply = (ctx: { invariants: { register(name: string, install: typeof install): () => void } }) =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-probe', install))
`,
    })
    expect(collectPackageInvariantViolations(empty).map(violation => violation.message))
      .toEqual(expect.arrayContaining([
        'install function must contain a package-owned invariant check',
        'install function must accept the bound failure reporter as its second parameter',
      ]))

    const unused = fixture({
      source: `
export const name = 'probe-invariant'
export const inject = ['invariants']
const install = (_ctx: unknown, _fail: (message: string) => never) => { void 0 }
export const apply = (ctx: { invariants: { register(name: string, install: typeof install): () => void } }) =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-probe', install))
`,
    })
    expect(collectPackageInvariantViolations(unused).map(violation => violation.message))
      .toContain('install function must use its bound failure reporter')
  })

  it('rejects duplicate name-based plugin observers across packages', () => {
    const root = fixture({
      source: nameObservedInvariant('@deepseek-ai/dsh-probe', 'shared-runtime-name'),
    })
    addConformingPackage(
      root,
      'probe-two',
      '@deepseek-ai/dsh-probe-two',
      nameObservedInvariant('@deepseek-ai/dsh-probe-two', 'shared-runtime-name'),
    )
    expect(collectPackageInvariantViolations(root).map(violation => violation.message))
      .toContain('name-based plugin invariant "shared-runtime-name" is already owned by "@deepseek-ai/dsh-probe-two"')
  })
})
