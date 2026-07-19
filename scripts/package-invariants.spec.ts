import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  collectPackageInvariantViolations,
  packageInvariantOwners,
  renderBaselineInvariant,
} from './package-invariants.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

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
  const owner = packageInvariantOwners(root)[0]!
  writeFileSync(join(dir, 'src/invariant.ts'), options.source ?? renderBaselineInvariant(owner))
  writeFileSync(
    join(dir, 'tsdown.config.ts'),
    options.buildEntry === false ? "export default { entry: ['lib/types/index.js'] }\n" : "export default { entry: ['lib/types/index.js', 'lib/types/invariant.js'] }\n",
  )
  return root
}

describe('package invariant gate', () => {
  it('accepts a generated owner companion with publication metadata', () => {
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
export const apply = (ctx: { invariants: { register(name: string, install: () => void): () => void } }) => {
  ctx.invariants.register('@deepseek-ai/dsh-foreign', () => {})
  return ctx.invariants.register(selected!, () => {})
}
`
    const violations = collectPackageInvariantViolations(fixture({ source }))
    expect(violations.map(violation => violation.message)).toEqual(expect.arrayContaining([
      expect.stringContaining('must resolve to a local string constant'),
      expect.stringContaining('must register exactly its own package name'),
    ]))
  })

  it('rejects edits to a generated baseline', () => {
    const root = fixture()
    const path = join(root, 'packages/core/probe/src/invariant.ts')
    writeFileSync(path, `${renderBaselineInvariant(packageInvariantOwners(root)[0]!)}// stale\n`)
    expect(collectPackageInvariantViolations(root).map(violation => violation.message))
      .toContain('generated baseline is stale; run pnpm run gen-package-invariants')
  })
})
