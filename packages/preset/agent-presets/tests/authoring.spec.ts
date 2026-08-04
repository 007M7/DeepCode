/**
 * Authoring a preset writes a composition into the deployment's `user` root.
 * The id is a directory name, so its pattern is a containment boundary rather
 * than a style rule; the shipped `.system` set stays read-only.
 */

import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import Include from '@cordisjs/plugin-include'
import { beforeEach, describe, expect, it } from 'vitest'
import AgentPresets, { COMPOSITION_FILE, assertComposition } from '@deepseek-ai/dsh-agent-presets'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const VALID = '- id: tool-alpha\n  name: ../../plugins/contribute.js\n  config:\n    tool: alpha\n'

let ctx: Context
let userRoot: string

beforeEach(async () => {
  userRoot = await mkdtemp(join(tmpdir(), 'dsh-preset-authoring-'))
  ctx = new Context()
  ctx.baseUrl = pathToFileURL(FIXTURES).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.plugin(AgentPresets, {
    default: 'standard',
    roots: [
      { path: join(FIXTURES, 'system'), trust: 'system' as const },
      { path: userRoot, trust: 'user' as const },
    ],
  })
})

describe('authoring a preset', () => {
  it('creates one in the user root and lists it', async () => {
    await ctx.agentPresets.write('mine', VALID)

    expect(await readFile(join(userRoot, 'mine', COMPOSITION_FILE), 'utf8')).toBe(VALID)
    const listed = await ctx.agentPresets.list()
    expect(listed.find(preset => preset.id === 'mine')?.trust).toBe('user')
  })

  it('reads back what it stored', async () => {
    await ctx.agentPresets.write('mine', VALID)

    expect(await ctx.agentPresets.read('mine')).toBe(VALID)
  })

  it('replaces an existing local preset', async () => {
    await ctx.agentPresets.write('mine', VALID)
    const next = '- id: tool-beta\n  name: ../../plugins/contribute.js\n  config:\n    tool: beta\n'

    await ctx.agentPresets.write('mine', next)

    expect(await ctx.agentPresets.read('mine')).toBe(next)
  })

  it('refuses an id that could escape the preset root', async () => {
    for (const id of ['../escape', 'a/b', '/abs', '..', 'Upper']) {
      await expect(ctx.agentPresets.write(id, VALID)).rejects.toThrow(/must match/)
    }
    // Nothing was created for any of them.
    expect(existsSync(join(userRoot, 'escape'))).toBe(false)
  })

  it('refuses text that is not a top-level entry list', async () => {
    await expect(ctx.agentPresets.write('bad', 'tools: [a, b]\n'))
      .rejects.toThrow(/top-level list of plugin rows/)
    await expect(ctx.agentPresets.write('bad', '- id: x\n  name: [unclosed\n'))
      .rejects.toThrow(/not a valid entry list/)

    expect(existsSync(join(userRoot, 'bad'))).toBe(false)
  })

  it('accepts a composition using the `!!js` dialect the include reads', () => {
    // A preset legitimately carries expressions; rejecting them would make
    // the editor refuse compositions the loader accepts.
    expect(() => { assertComposition('- id: x\n  name: y\n  config:\n    cwd: !!js process.cwd()\n') })
      .not.toThrow()
  })

  it('refuses to overwrite a preset that ships with the deployment', async () => {
    await expect(ctx.agentPresets.write('standard', VALID))
      .rejects.toThrow(/ships with the deployment/)

    expect(await ctx.agentPresets.read('standard')).not.toBe(VALID)
  })
})

describe('deleting a preset', () => {
  it('removes a locally authored one', async () => {
    await ctx.agentPresets.write('mine', VALID)

    await ctx.agentPresets.remove('mine')

    expect(existsSync(join(userRoot, 'mine'))).toBe(false)
    expect((await ctx.agentPresets.list()).some(preset => preset.id === 'mine')).toBe(false)
  })

  it('refuses to delete a shipped one', async () => {
    await expect(ctx.agentPresets.remove('standard'))
      .rejects.toThrow(/ships with the deployment/)
  })

  it('reports an unknown id rather than silently succeeding', async () => {
    await expect(ctx.agentPresets.remove('never-existed')).rejects.toThrow(/not found/)
  })
})

describe('a deployment with more than one user root', () => {
  it('refuses to delete a preset the writable root does not own', async () => {
    const second = await mkdtemp(join(tmpdir(), 'dsh-preset-second-'))
    await mkdir(join(second, 'elsewhere'), { recursive: true })
    await writeFile(join(second, 'elsewhere', COMPOSITION_FILE), VALID)
    const layered = new Context()
    layered.baseUrl = pathToFileURL(FIXTURES).href + '/'
    await layered.plugin(Loader)
    layered.loader.builtins.include = Include
    await layered.plugin(AgentPresets, {
      default: 'standard',
      roots: [
        { path: userRoot, trust: 'user' as const },
        { path: second, trust: 'user' as const },
      ],
    })

    // Writes go to the first user root, so a preset discovered from a later
    // one is `user` trust yet outside what deletion is allowed to touch —
    // `rm -r` on a directory this root does not own is the failure to avoid.
    await expect(layered.agentPresets.remove('elsewhere'))
      .rejects.toThrow(/does not live under the writable preset root/)
    expect(existsSync(join(second, 'elsewhere'))).toBe(true)
  })
})

describe('a deployment with no writable root', () => {
  it('says authoring is unavailable rather than guessing a directory', async () => {
    const readOnly = new Context()
    readOnly.baseUrl = pathToFileURL(FIXTURES).href + '/'
    await readOnly.plugin(Loader)
    readOnly.loader.builtins.include = Include
    await readOnly.plugin(AgentPresets, {
      default: 'standard',
      roots: [{ path: join(FIXTURES, 'system'), trust: 'system' as const }],
    })

    expect(readOnly.agentPresets.authorable).toBe(false)
    await expect(readOnly.agentPresets.write('mine', VALID))
      .rejects.toThrow(/no user-writable preset root/)
  })
})

describe('a user root that does not exist yet', () => {
  it('is created by the first save', async () => {
    const absent = join(await mkdtemp(join(tmpdir(), 'dsh-preset-absent-')), 'nested', 'preset')
    const fresh = new Context()
    fresh.baseUrl = pathToFileURL(FIXTURES).href + '/'
    await fresh.plugin(Loader)
    fresh.loader.builtins.include = Include
    await fresh.plugin(AgentPresets, {
      default: 'mine',
      roots: [{ path: absent, trust: 'user' as const }],
    })

    await fresh.agentPresets.write('mine', VALID)

    expect(await readFile(join(absent, 'mine', COMPOSITION_FILE), 'utf8')).toBe(VALID)
  })
})

describe('a stray file beside the preset directories', () => {
  it('does not become a preset', async () => {
    await mkdir(join(userRoot, 'not-a-preset'), { recursive: true })
    await writeFile(join(userRoot, 'not-a-preset', 'README.txt'), 'nope\n')

    expect((await ctx.agentPresets.list()).some(preset => preset.id === 'not-a-preset')).toBe(false)
  })
})
