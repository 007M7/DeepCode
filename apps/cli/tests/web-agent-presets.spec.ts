import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { Context } from 'cordis'
import { boot, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PatchOptions } from '@cordisjs/plugin-include'
import { beforeAll, describe, expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-tools'

const CONFIG_DIR = fileURLToPath(new URL('../config/', import.meta.url))
const BASE_CONFIG = join(CONFIG_DIR, 'base.cordis.yml')
const WEB_OVERLAY = join(CONFIG_DIR, 'web.cordis.yml')

/**
 * Boot the shipped Web composition, minus the rows that would bind a port,
 * touch the network, or write outside the test. Everything that decides an
 * agent's capabilities is the real thing, including both shipped presets.
 */
async function bootWeb(): Promise<Context> {
  const patches: PatchOptions[] = [
    ...loadOverlayPatches('dsh-test', WEB_OVERLAY),
    // Host rows with side effects outside this process: a bound port, a
    // served asset tree, a telemetry exporter.
    { id: 'webserver', disabled: true },
    { id: 'telemetry-otel', disabled: true },
    { id: 'modules', disabled: true },
    { id: 'connection', disabled: true },
    // NOT a side-effect row: the api-proxy cannot mount in THIS layer at all,
    // because it injects `subagents` and the subagent registry moved into the
    // presets here. That is the breakage a later layer returns to the host
    // plane; when it does, this line comes out and the boot audit covers the
    // whole host-plane injection graph again.
    { id: 'api-gateway', disabled: true },
    { id: 'directory-picker', disabled: true },
    // The roster AppCLIEntry would patch in; only the shipped root, so a
    // developer's own `~/.dsh/.preset` cannot change this test's outcome.
    {
      id: 'agent-presets',
      config: { default: 'standard', roots: [{ path: join(CONFIG_DIR, 'agent-presets'), trust: 'system' }] },
    },
  ]
  return await boot('dsh-test', BASE_CONFIG, patches)
}

const toolNames = (ctx: Context, agent?: Agent): string[] =>
  ctx.tools.schemas(agent).map(schema => schema.name).sort()

let ctx: Context
beforeAll(async () => {
  ctx = await bootWeb()
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

    expect(listed.map(preset => preset.id).sort()).toEqual(['core-web', 'standard'])
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
        'get_goal', 'list_agents', 'ralph', 'read', 'send_message', 'skill',
        'str_replace_editor', 'subagent', 'subagent_fork', 'task_kill',
        'task_list', 'task_output', 'todo_write', 'update_goal', 'web_search',
        'workflow', 'write',
      ])
    } finally {
      await handle.dispose()
    }
  })

  it('composes exactly two tools from `core-web`', async () => {
    const handle = await ctx.agents.create({
      sessionId: SessionId('preset-core-web'),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'core-web').then(() => undefined),
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
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'core-web').then(() => undefined),
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
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'core-web').then(() => undefined),
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

describe('a forked session', () => {
  it('inherits the composition its seeded history was produced under', async () => {
    const parent = await ctx.agents.create({
      sessionId: SessionId('preset-fork-parent'),
      meta: { agentPreset: 'core-web' },
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'core-web').then(() => undefined),
    })
    const inherited = parent.agent.session.header.agentPreset
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

describe('a session keeps the preset it was created with', () => {
  it('records the preset the gateway guard reads', async () => {
    const handle = await ctx.agents.create({
      sessionId: SessionId('preset-locked'),
      meta: { agentPreset: 'core-web' },
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'core-web').then(() => undefined),
    })
    try {
      // The api-proxy guard reads exactly this: the header records what the
      // session runs, so naming anything else is a caller error rather than a
      // switch. Its history was produced under `core-web`'s two tools.
      expect(handle.agent.session.header.agentPreset).toBe('core-web')
    } finally {
      await handle.dispose()
    }
  })
})
