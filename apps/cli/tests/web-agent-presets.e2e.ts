import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Context } from 'cordis'
import { boot, healProfilesModuleFallback, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PatchOptions } from '@cordisjs/plugin-include'
import { beforeAll, describe, expect, it } from 'vitest'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { resolveSessionPreset, SETTINGS_NAMESPACE } from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-tools'

const CONFIG_DIR = fileURLToPath(new URL('../config/', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
/** The shipped Web surface: the dsh-base and dsh-web-app bundle patches over an empty preset root. */
const BASE_PATCH = join(REPO_ROOT, 'packages/bundle/base/cordis.patch.yml')
const WEB_PATCH = join(REPO_ROOT, 'packages/bundle/web-app/cordis.patch.yml')
/** The installation anchor whose dependency surface the preset module fallback mirrors. */
const INSTALL_ANCHOR = join(REPO_ROOT, 'apps/cli/package.json')

/**
 * Boot the shipped Web composition, minus the rows that would bind a port,
 * touch the network, or write outside the test. Everything that decides an
 * agent's capabilities is the real thing, including both shipped presets.
 */
async function bootWeb(settingsFile: string, extra: PatchOptions[] = []): Promise<Context> {
  const storageRoot = join(dirname(settingsFile), 'storages')
  const patches: PatchOptions[] = [
    ...loadOverlayPatches('dsh-test', BASE_PATCH),
    ...loadOverlayPatches('dsh-test', WEB_PATCH),
    // The settings row defaults to `$DSH_HOME/settings.yaml`. Left alone it
    // reads the developer's own document — and since the default preset is a
    // setting, a stored `agent-presets.default` would decide this file's
    // outcome. Point it at a temp file for the same reason the roster below
    // names only the shipped root.
    { id: 'settings', config: { path: settingsFile, watch: false } },
    // storage-json's root is anchored to the real $DSH_HOME. Unpinned, this
    // file writes the developer's own `~/.dsh/storages/` — and then reads it
    // back on the next run, so a stored document from any other build decides
    // this test's boot. Same reason the settings row above is pinned.
    { id: 'storage-json', config: { root: storageRoot } },
    // Host rows with side effects outside this process: a bound port, a served
    // asset tree, a telemetry exporter. `api-gateway` and `directory-picker`
    // stay ENABLED on purpose — the api-proxy is the host row that injects
    // `subagents`, `workspace`, and the rest of the agent plane, so disabling
    // it would hide exactly the breakage this file exists to catch: a service
    // moved into the presets that a host row still waits for. The boot audit
    // is that assertion.
    { id: 'webserver', disabled: true },
    // The web bundle's runtime row injects `httpServer`, so it cannot
    // activate without the bound port disabled above. It owns dist serving
    // and the URL prompt line — surface glue, not anything that decides an
    // agent's capabilities, which is all this file asserts.
    { id: 'web-runtime', disabled: true },
    { id: 'telemetry-otel', disabled: true },
    { id: 'modules', disabled: true },
    { id: 'connection', disabled: true },
    // The shipped `-auto` chooser resolves its interaction from a running
    // host and so waits for the webserver disabled above; the browse variant
    // supplies `directoryPicker` without one.
    { id: 'directory-picker', disabled: true },
    { insert: [{ id: 'directory-picker-browse', name: '@deepseek-ai/dsh-host-directory-picker-browse' }] },
    // The roster AppCLIEntry would patch in; only the shipped root, so a
    // developer's own `~/.dsh/.preset` cannot change this test's outcome.
    // `default` here is the COMPOSITION default — the base layer the settings
    // document overrides.
    {
      id: 'agent-presets',
      config: { default: 'standard', roots: [{ path: join(CONFIG_DIR, 'agent-presets'), trust: 'system' }] },
    },
    ...extra,
  ]
  // The surface is patch layers over an empty preset root, so the root sits
  // outside this workspace and bare plugin names cannot resolve by Node's
  // upward walk. The flat fallback the preset boot maintains is what makes
  // them resolvable — the same mechanism, not a test-only shim.
  const home = dirname(settingsFile)
  healProfilesModuleFallback(INSTALL_ANCHOR, home)
  const profileDir = join(home, 'profiles', 'spec')
  await mkdir(profileDir, { recursive: true })
  const rootConfig = join(profileDir, 'cordis.yml')
  await writeFile(rootConfig, '[]\n')
  return await boot('dsh-test', rootConfig, patches)
}

const toolNames = (ctx: Context, agent?: Agent): string[] =>
  ctx.tools.schemas(agent).map(schema => schema.name).sort()

let ctx: Context
beforeAll(async () => {
  const settingsFile = join(await mkdtemp(join(tmpdir(), 'dsh-web-presets-')), 'settings.yaml')
  await writeFile(settingsFile, '{}\n')
  ctx = await bootWeb(settingsFile)
}, 120_000)

describe('the shipped Web composition', () => {
  it('leaves the global tool layer empty', () => {
    // Every model-facing tool belongs to a preset, `ask_user_question`
    // included: a tool in the global layer reaches EVERY agent regardless of
    // which preset composed it, so a two-tool benchmark surface would really
    // present three. A regression here means an agent-plane row came back to
    // the host composition.
    expect(toolNames(ctx)).toEqual([])
  })

  it('supplies both shipped presets, and only those, from the system root', async () => {
    const listed = await ctx.agentPresets.list()

    expect(listed.map(preset => preset.id).sort()).toEqual(['code', 'cordis', 'minimal', 'standard'])
    expect(listed.every(preset => preset.trust === 'system')).toBe(true)
    expect(ctx.agentPresets.defaultId).toBe('standard')
  })

  it('composes the full agent from `standard`', async () => {
    const handle = await ctx.agents.create({
      sessionId: SessionId('preset-standard'),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
    })
    try {
      // The EXACT catalog, not a spot-check: an omission is this design's
      // quietest failure mode, because a row that registers into the wrong
      // layer mounts cleanly and simply contributes nothing. `glob`/`grep` are
      // excluded for the reason the TUI composition e2e excludes them — they
      // depend on ripgrep being present on the machine.
      expect(toolNames(ctx, handle.agent).filter(name => name !== 'glob' && name !== 'grep')).toEqual([
        'ask_user_question', 'bash', 'create_goal', 'edit', 'exit_plan_mode',
        'get_goal', 'interrupt_agent', 'list_agents', 'ralph', 'read', 'send_message', 'skill',
        'str_replace_editor', 'subagent', 'subagent_fork', 'task_kill',
        'task_list', 'task_output', 'todo_write', 'update_goal', 'web_search',
        'workflow', 'write',
      ])
    } finally {
      await handle.dispose()
    }
  })

  it('composes exactly two tools from `minimal`', async () => {
    const handle = await ctx.agents.create({
      sessionId: SessionId('preset-minimal'),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'minimal').then(() => undefined),
    })
    try {
      // Exactly what the preset lists — nothing arrives from the host.
      expect(toolNames(ctx, handle.agent)).toEqual(['bash', 'str_replace_editor'])
    } finally {
      await handle.dispose()
    }
  })

  it('keeps two differently composed sessions independent', async () => {
    const full = await ctx.agents.create({
      sessionId: SessionId('preset-both-full'),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
    })
    const minimal = await ctx.agents.create({
      sessionId: SessionId('preset-both-minimal'),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'minimal').then(() => undefined),
    })
    try {
      expect(toolNames(ctx, minimal.agent)).toEqual(['bash', 'str_replace_editor'])
      expect(toolNames(ctx, full.agent).length).toBeGreaterThan(10)

      await minimal.dispose()

      // Tearing the minimal session down leaves the full one whole.
      expect(toolNames(ctx, full.agent).length).toBeGreaterThan(10)
      expect(toolNames(ctx)).toEqual([])
    } finally {
      await full.dispose()
    }
  })

  it('composes the cordis agent with its own toolset', async () => {
    const handle = await ctx.agents.create({
      sessionId: SessionId('preset-cordis'),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'cordis').then(() => undefined),
    })
    try {
      const tools = toolNames(ctx, handle.agent)
      // The self-referential toolset is what distinguishes this preset.
      expect(tools).toEqual(expect.arrayContaining(['cordis_inspect', 'cordis_mount', 'cordis_unmount']))
      // And it keeps the standard agent's own tools rather than replacing them.
      expect(tools).toEqual(expect.arrayContaining(['bash', 'read', 'edit', 'skill']))

      // The skill registry sits in this preset's entry-local realm, so it is
      // invisible to the host AND to the agent's own scope — only the rows
      // inside that group resolve it, which is what makes `tool-skill` the
      // agent's own rather than a shared one.
      expect(ctx.get('skills')).toBeUndefined()
    } finally {
      await handle.dispose()
    }
  })

  it('presents `code` as Code Mode without disturbing a native session beside it', async () => {
    const coded = await ctx.agents.create({
      sessionId: SessionId('preset-code'),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'code').then(() => undefined),
    })
    const native = await ctx.agents.create({
      sessionId: SessionId('preset-code-native'),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
    })
    try {
      // One tool reaches the MODEL: the transport. The registry's catalog for
      // this agent is unchanged — a code mode collapses the presentation, not
      // the capabilities — so the assembly is what carries the claim.
      const assembly = await ctx.systemPrompt.assemble({ scope: coded.agent })
      expect(assembly.tools.map(tool => tool.name)).toEqual(['run_code'])
      expect(toolNames(ctx, coded.agent)).toContain('str_replace_editor')
      const sdk = assembly.sections.find(section => section.name === 'tools:sdk')?.text ?? ''
      expect(sdk).toContain('str_replace_editor')
      expect(sdk).toContain('web_search')

      // The presentation is this agent's alone: the deployment default is
      // native, and the session composed from `standard` still sees it.
      const nativeAssembly = await ctx.systemPrompt.assemble({ scope: native.agent })
      expect(nativeAssembly.tools.map(tool => tool.name)).toContain('bash')
      expect(nativeAssembly.tools.map(tool => tool.name)).not.toContain('run_code')
      expect(nativeAssembly.sections.some(section => section.name === 'tools:sdk')).toBe(false)
    } finally {
      await native.dispose()
      await coded.dispose()
    }
  })

  it('keeps the self-referential toolset out of every other preset', async () => {
    const handle = await ctx.agents.create({
      sessionId: SessionId('preset-no-cordis'),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
    })
    try {
      // Editing the live runtime is opt-in per session, not ambient.
      expect(toolNames(ctx, handle.agent)).not.toContain('cordis_mount')
    } finally {
      await handle.dispose()
    }
  })

  it('ships the composition-authoring skill inside the preset directory', async () => {
    // The preset's skill root is derived from its own `baseUrl`, so the skill
    // travels with the directory wherever the preset is installed.
    const skill = join(
      CONFIG_DIR, 'agent-presets', 'cordis', 'skills', 'editing-cordis-compositions', 'SKILL.md',
    )

    expect((await readFile(skill, 'utf8')).startsWith('---\nname: editing-cordis-compositions')).toBe(true)
  })

  it('never rewrites the preset file it composed from', async () => {
    // The Loader persists a tree whose plugin self-disposed, and tearing an
    // agent down disposes its whole subtree. Inherited, that rewrote the
    // shipped composition — truncating it to `[]` the first time a session
    // ended — so `PresetTree` refuses to write at all.
    const path = join(CONFIG_DIR, 'agent-presets', 'standard', 'agent.cordis.yml')
    const before = await readFile(path, 'utf8')

    const handle = await ctx.agents.create({
      sessionId: SessionId('preset-readonly'),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
    })
    await handle.dispose()
    // Slack, not a race the number has to win. The write is driven by the
    // Loader's fiber-unload listener, which fires as the subtree's fibers
    // settle rather than when `dispose()` resolves, and the Loader exposes no
    // flush to await. A regression writes synchronously inside that listener,
    // so any wait past settlement fails; a longer one only slows the test.
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(await readFile(path, 'utf8')).toBe(before)
  })

  it('gives each session its own persona', async () => {
    const handle = await ctx.agents.create({
      sessionId: SessionId('preset-persona'),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'minimal').then(() => undefined),
    })
    try {
      const assembly = await ctx.systemPrompt.assemble({ scope: handle.agent })
      expect(assembly.sections.find(section => section.name === 'deployment:persona')?.text)
        .toContain('You are a coding agent powered by')
    } finally {
      await handle.dispose()
    }
  })
})

describe('a switch survives the session', () => {
  it('records the choice so the log states what the agent runs', async () => {
    const handle = await ctx.agents.create({
      sessionId: SessionId('preset-switch-logged'),
      meta: { agentPreset: 'standard' },
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
    })
    try {
      // The api-proxy's select does exactly this pair while the session is blank.
      await ctx.agentPresets.recompose(handle.agent.ctx, 'minimal')
      handle.agent.session.append('agent-preset/selected', { agentPreset: 'minimal' })

      // The header keeps the creation fact; the log carries what it runs.
      expect(handle.agent.session.header.agentPreset).toBe('standard')
      expect(resolveSessionPreset(handle.agent.session)).toBe('minimal')
    } finally {
      await handle.dispose()
    }
  })

  it('rebuilds a switched session from the log, not the creation header', () => {
    // The exact shape a resume reads back from disk: the header says standard,
    // the log records the switch the user made while the session was blank.
    const rebuilt = resolveSessionPreset({
      header: { version: 0, id: SessionId('x'), createdAt: 0, agentPreset: 'standard' },
      events: [
        { type: 'agent-preset/selected', seq: 1, time: 0, data: { agentPreset: 'minimal' } },
        { type: 'turn/start', seq: 2, time: 0, data: { turn: 0, trigger: { kind: 'message', source: { kind: 'user' } } } },
      ] as never,
    })

    // Reading the header alone would compose the creation-time preset over a
    // history another one produced — the replay the blank-only lock prevents.
    expect(rebuilt).toBe('minimal')
  })
})

describe('a forked session', () => {
  it('inherits the composition its seeded history was produced under', async () => {
    const parent = await ctx.agents.create({
      sessionId: SessionId('preset-fork-parent'),
      meta: { agentPreset: 'minimal' },
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'minimal').then(() => undefined),
    })
    const inherited = resolveSessionPreset(parent.agent.session)
    const child = await ctx.agents.create({
      sessionId: SessionId('preset-fork-child'),
      meta: {
        parentSession: SessionId('preset-fork-parent'),
        seedLength: 0,
        ...inherited === undefined ? {} : { agentPreset: inherited },
      },
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, inherited).then(() => undefined),
    })
    try {
      // Composing nothing would leave the child empty: this layer moved every
      // model-facing row out of the host plane, so there is nothing to inherit
      // for free any more.
      expect(toolNames(ctx, child.agent)).toEqual(toolNames(ctx, parent.agent))
      expect(toolNames(ctx, child.agent).length).toBeGreaterThan(0)
    } finally {
      await child.dispose()
      await parent.dispose()
    }
  })
})

describe('authoring a preset on the shipped composition', () => {
  let authorCtx: Context
  let userRoot: string

  beforeAll(async () => {
    userRoot = join(await mkdtemp(join(tmpdir(), 'dsh-preset-authoring-')), 'profiles')
    const settingsFile = join(await mkdtemp(join(tmpdir(), 'dsh-preset-authoring-settings-')), 'settings.yaml')
    await writeFile(settingsFile, '{}\n')
    authorCtx = await bootWeb(settingsFile, [{
      id: 'agent-presets',
      config: {
        default: 'standard',
        roots: [
          { path: join(CONFIG_DIR, 'agent-presets'), trust: 'system' },
          // The root does not exist yet: a deployment whose user has authored
          // nothing is the normal first-run state.
          { path: userRoot, trust: 'user' },
        ],
      },
    }])
  })

  it('refuses to copy over or delete a shipped preset', async () => {
    await expect(authorCtx.agentPresets.copy('minimal', 'standard')).rejects.toThrow(/already exists/)
    await expect(authorCtx.agentPresets.remove('standard')).rejects.toThrow(/ships with the deployment/)
  })

  it.each(['../escape', 'a/b', '/abs', 'Upper'])('refuses the uncontainable id %j', async (id) => {
    // The id becomes a directory name under the user root, so containment is
    // checked on the id rather than on the joined path afterwards.
    await expect(authorCtx.agentPresets.copy('minimal', id)).rejects.toThrow()
  })

  it('copies a shipped preset a session then really composes from', async () => {
    await authorCtx.agentPresets.copy('minimal', 'my-agent', '我的模式')

    // Round-trips through the roster as a `user` row carrying the given name
    // and the source's description, over the source's own composition text.
    const preset = await authorCtx.agentPresets.resolve('my-agent')
    const source = await authorCtx.agentPresets.resolve('minimal')
    expect(preset.trust).toBe('user')
    expect(preset.name).toBe('我的模式')
    expect(preset.description).toBe(source.description)
    expect(await authorCtx.agentPresets.read('my-agent')).toBe(await authorCtx.agentPresets.read('minimal'))
    // Owner-only, in an owner-only directory: a composition is executable
    // configuration on a machine that may have other users.
    expect((await stat(preset.path)).mode & 0o777).toBe(0o600)
    const handle = await authorCtx.agents.create({
      sessionId: SessionId('preset-authored'),
      setup: agentCtx => authorCtx.agentPresets.mount(agentCtx, 'my-agent').then(() => undefined),
    })
    try {
      // The same tools the shipped `minimal` composes, from a directory copied
      // through the service into a root outside the installed harness.
      expect(toolNames(authorCtx, handle.agent)).toEqual(['bash', 'str_replace_editor'])
    } finally {
      await handle.dispose()
    }
  })

  it('deletes what it copied', async () => {
    await authorCtx.agentPresets.copy('minimal', 'doomed')

    await authorCtx.agentPresets.remove('doomed')

    expect((await authorCtx.agentPresets.list()).map(preset => preset.id)).not.toContain('doomed')
  })
})

/**
 * Which preset an unnamed session gets is a user setting layered over the
 * composition's own default. The package suite proves the layering against a
 * hand-built context; this proves it through the shipped `cordis.yml` — that
 * the roster and the settings provider are actually wired to each other, and
 * that the id the setting names is the one a session composes from.
 */
describe('the default preset as a user setting', () => {
  it('composes an unnamed session from the stored default, not the composed one', async () => {
    expect(ctx.agentPresets.defaultId).toBe('standard')

    await ctx.settings.update(settingsNamespace(SETTINGS_NAMESPACE), { default: 'minimal' })
    try {
      expect(ctx.agentPresets.defaultId).toBe('minimal')

      const handle = await ctx.agents.create({
        sessionId: SessionId('preset-user-default'),
        setup: agentCtx => ctx.agentPresets.mount(agentCtx).then(() => undefined),
      })
      try {
        // `mount()` with no id resolves the effective default. Two tools, not
        // `standard`'s catalog: the setting decided the composition.
        expect(toolNames(ctx, handle.agent)).toEqual(['bash', 'str_replace_editor'])
      } finally {
        await handle.dispose()
      }
    } finally {
      // The context is shared with the rest of the file. `replace({})` drops
      // the user section wholesale so the field re-inherits the composition
      // base; `update` merges, and would leave the override standing.
      await ctx.settings.replace(settingsNamespace(SETTINGS_NAMESPACE), {})
    }

    expect(ctx.agentPresets.defaultId).toBe('standard')
  })
})

describe('a session keeps the preset it was created with', () => {
  it('refuses to adopt a live session under a different preset', async () => {
    const handle = await ctx.agents.create({
      sessionId: SessionId('preset-locked'),
      meta: { agentPreset: 'minimal' },
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'minimal').then(() => undefined),
    })
    try {
      // The api-proxy guard reads exactly this: the header records what the
      // session runs, so naming anything else is a caller error rather than a
      // switch. Its history was produced under `minimal`'s two tools.
      expect(handle.agent.session.header.agentPreset).toBe('minimal')
    } finally {
      await handle.dispose()
    }
  })
})
