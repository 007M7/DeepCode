import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { coverageArgs, coverageShards } from './coverage-shards.ts'

const repositoryRoot = resolve(import.meta.dirname, '..')

describe('coverage shards', () => {
  it('assigns every workspace package to exactly one lane', () => {
    const packagesRoot = resolve(repositoryRoot, 'packages')
    const workspacePackages = readdirSync(packagesRoot, { withFileTypes: true })
      .filter(group => group.isDirectory())
      .flatMap(group => readdirSync(resolve(packagesRoot, group.name), { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => `${group.name}/${entry.name}`))
      .sort()
    const assignedPackages = coverageShards.flatMap(shard => shard.packageRoots.flatMap((packageRoot) => {
      if (packageRoot.includes('/')) return [packageRoot]
      return readdirSync(resolve(packagesRoot, packageRoot), { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => `${packageRoot}/${entry.name}`)
    }))

    expect([...assignedPackages].sort()).toEqual(workspacePackages)
    expect(new Set(assignedPackages).size).toBe(assignedPackages.length)
  })

  it.each(coverageShards)('selects tests and source includes for $name', (shard) => {
    const args = coverageArgs(shard.name)
    for (const packageRoot of shard.packageRoots) {
      expect(args).toContain(`packages/${packageRoot}`)
      expect(args).toContain(packageRoot.includes('/')
        ? `--coverage.include=packages/${packageRoot}/src/**/*.ts`
        : `--coverage.include=packages/${packageRoot}/*/src/**/*.ts`)
    }
    expect(args).toContain('scripts/test-invariants.spec.ts')
    expect(new Set(args).size).toBe(args.length)
  })

  it('rejects an unknown lane', () => {
    expect(() => coverageArgs('missing')).toThrow('unknown DSH_COVERAGE_SHARD')
  })
})
