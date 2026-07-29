import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const generated = vi.hoisted(() => vi.fn(() => [
  {
    package: '@deepseek-ai/dsh-tools',
    packageRoot: 'packages/core/tools',
    face: 'host' as const,
    exports: [],
    js: 'export const host = true\n',
    dts: 'export declare const host: true\n',
  },
  {
    package: '@deepseek-ai/dsh-tools',
    packageRoot: 'packages/core/tools',
    face: 'client' as const,
    exports: [],
    js: 'export const client = true\n',
    dts: 'export declare const client: true\n',
  },
]))

vi.mock('../src/workspace.ts', () => ({
  WorkspaceTypertGenerator: class {
    generate = generated
  },
}))

const { typertPlugin } = await import('../src/tsdown-plugin.ts')
const roots: string[] = []

afterEach(() => {
  generated.mockClear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('typertPlugin', () => {
  it('skips outputs that do not identify a Typert contributor', async () => {
    const plugin = typertPlugin()
    expect(plugin.name).toBe('dsh-typert-generator')
    plugin.writeBundle({})

    const root = await workspace()
    const orphan = join(root, 'orphan', 'lib')
    await mkdir(orphan, { recursive: true })
    plugin.writeBundle({ dir: orphan })

    const unnamed = await packageOutput(root, 'unnamed', {})
    plugin.writeBundle({ dir: unnamed })
    const other = await packageOutput(root, 'other', { name: '@fixture/other' })
    plugin.writeBundle({ dir: other })

    expect(generated).not.toHaveBeenCalled()
    expect(() => { plugin.writeBundle({ dir: join(root, '..', 'outside', 'lib') }) })
      .toThrow('cannot find workspace root')
  })

  it('writes every generated face beside a nested package bundle', async () => {
    const root = await workspace()
    const output = await packageOutput(root, 'tools', {
      name: '@deepseek-ai/dsh-tools',
      exports: { './typert': './lib/typert.host.js' },
    }, 'lib/dev')
    const clientOutput = await packageOutput(root, 'client-tools', {
      name: '@deepseek-ai/dsh-tools',
      exports: { './client/typert': './lib/typert.client.js' },
    })

    const plugin = typertPlugin()
    plugin.writeBundle({ dir: output })
    plugin.writeBundle({ dir: clientOutput })

    expect(generated).toHaveBeenCalledOnce()
    expect(generated).toHaveBeenCalledWith()
    const packageLib = join(root, 'packages', 'tools', 'lib')
    expect(readFileSync(join(packageLib, 'typert.host.js'), 'utf8')).toBe('export const host = true\n')
    expect(readFileSync(join(packageLib, 'typert.host.d.ts'), 'utf8')).toBe('export declare const host: true\n')
    expect(readFileSync(join(packageLib, 'typert.client.js'), 'utf8')).toBe('export const client = true\n')
    expect(existsSync(join(packageLib, 'typert.client.d.ts'))).toBe(true)
    expect(readFileSync(join(root, 'packages/client-tools/lib/typert.client.js'), 'utf8'))
      .toBe('export const client = true\n')
  })
})

async function workspace(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-typert-tsdown-'))
  roots.push(root)
  writeFileSync(join(root, 'tsconfig.host.json'), '{}\n')
  return root
}

async function packageOutput(
  root: string,
  directory: string,
  manifest: Record<string, unknown>,
  output = 'lib',
): Promise<string> {
  const packageRoot = join(root, 'packages', directory)
  const result = join(packageRoot, output)
  await mkdir(result, { recursive: true })
  writeFileSync(join(packageRoot, 'package.json'), `${JSON.stringify(manifest)}\n`)
  return result
}
