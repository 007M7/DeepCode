import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { COMPOSITION_FILE, discoverPresets, scanRoot } from '@deepseek-ai/dsh-agent-presets'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const SYSTEM = { path: join(FIXTURES, 'system'), trust: 'system' as const }
const USER = { path: join(FIXTURES, 'user'), trust: 'user' as const }

describe('display order', () => {
  it('puts declared order first, then everything else by id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-order-'))
    for (const [id, order] of [['zulu', 1], ['alpha', 2]] as const) {
      await mkdir(join(root, id), { recursive: true })
      await writeFile(join(root, id, COMPOSITION_FILE), '[]\n')
      await writeFile(join(root, id, 'preset.yml'), `order: ${String(order)}\n`)
    }
    for (const id of ['bravo', 'yankee']) {
      await mkdir(join(root, id), { recursive: true })
      await writeFile(join(root, id, COMPOSITION_FILE), '[]\n')
    }

    const found = await scanRoot({ path: root, trust: 'system' })

    // The shipped set reads by capability; presets that declare nothing stay
    // alphabetical behind them rather than interleaving unpredictably.
    expect(found.map(preset => preset.id)).toEqual(['zulu', 'alpha', 'bravo', 'yankee'])
  })
})

describe('preset discovery', () => {
  it('reports one preset per directory holding a composition, ordered by id', async () => {
    const found = await scanRoot(SYSTEM)

    expect(found.map(preset => preset.id)).toEqual(['minimal', 'standard'])
    expect(found[0]).toEqual({
      id: 'minimal',
      trust: 'system',
      path: join(SYSTEM.path, 'minimal', COMPOSITION_FILE),
    })
  })

  it('skips a directory that holds no composition file', async () => {
    const found = await scanRoot(USER)

    expect(found.map(preset => preset.id)).not.toContain('not-a-preset')
  })

  it('records the root trust on every preset it discovers', async () => {
    const found = await scanRoot(USER)

    expect(found.every(preset => preset.trust === 'user')).toBe(true)
  })

  it('lets the earlier root win a duplicate id', async () => {
    const found = await discoverPresets([SYSTEM, USER])

    const standard = found.filter(preset => preset.id === 'standard')
    expect(standard).toHaveLength(1)
    expect(standard[0]?.trust).toBe('system')
  })

  it('treats an absent root as supplying no presets', async () => {
    const found = await scanRoot({ path: join(FIXTURES, 'no-such-root'), trust: 'user' })

    expect(found).toEqual([])
  })

  it('ignores a plain file sitting beside the preset directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-presets-'))
    await writeFile(join(root, 'stray.yml'), '- id: x\n')
    await mkdir(join(root, 'real'))
    await writeFile(join(root, 'real', COMPOSITION_FILE), '[]\n')

    const found = await scanRoot({ path: root, trust: 'user' })

    expect(found.map(preset => preset.id)).toEqual(['real'])
  })

  it('reports a root it cannot read rather than treating it as empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-presets-'))
    const notADirectory = join(root, 'file-as-root')
    await writeFile(notADirectory, 'not a directory\n')

    await expect(scanRoot({ path: notADirectory, trust: 'user' }))
      .rejects.toThrow(/cannot read preset root/)
  })

  it('expands a leading tilde in a root path', async () => {
    // `~` alone resolves to the home directory, which exists but holds no
    // preset directories; the point is that it did not throw on a literal `~`.
    const found = await scanRoot({ path: '~/.dsh-agent-presets-absent', trust: 'user' })

    expect(found).toEqual([])
  })
})
