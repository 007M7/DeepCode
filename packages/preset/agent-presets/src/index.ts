/**
 * Agent presets: each session composes its model-facing plugin set from one
 * preset `cordis.yml` mounted under that agent's scope context.
 *
 * This package owns the preset vocabulary, filesystem discovery, and the
 * guarded mount. It does not decide when an agent is created — the agent
 * factory's `setup(agentCtx)` hook is the one supported call site, because
 * only there is the composition installed while the agent is still
 * unpublished, so a rejected mount rolls the whole creation back.
 * @module @deepseek-ai/dsh-agent-presets
 */

import { Context, Service } from 'cordis'
import z from 'schemastery'
import { discoverPresets } from './discovery.ts'
import { mountPreset, serviceForAgent } from './mount.ts'
import { UnknownPresetError, type AgentPreset, type Config } from './types.ts'

export { COMPOSITION_FILE, discoverPresets, scanRoot } from './discovery.ts'
export {
  inactiveRows, leakedServices, livePresetMounts, mountPreset, serviceForAgent, type PresetMount,
} from './mount.ts'
export { PresetMountError, UnknownPresetError } from './types.ts'
export type { AgentPreset, Config, PresetRoot, PresetTrust } from './types.ts'

declare module 'cordis' {
  interface Context {
    agentPresets: AgentPresets
  }
}

/**
 * Registry over the deployment's agent presets.
 *
 * Discovery is unmemoized: `list()` and `resolve()` re-read the roots on every
 * call so a preset authored while the process runs is visible immediately,
 * and a preset deleted underneath a picker disappears from the next read.
 */
export class AgentPresets extends Service {
  static inject = ['loader']

  /** Runtime schema for the preset roster. */
  static Config = z.object({
    default: z.string().required(),
    roots: z.array(z.object({
      path: z.string().required(),
      trust: z.union(['system', 'user'] as const).default('user'),
    })).default([]),
  }) as z<Config>

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'agentPresets')
  }

  /** The preset id mounted when a caller names none. */
  get defaultId(): string {
    return this.config.default
  }

  /**
   * Every preset the configured roots currently supply.
   * @returns the presets, first-root-wins per id.
   */
  async list(): Promise<AgentPreset[]> {
    return await discoverPresets(this.config.roots)
  }

  /**
   * Resolve one preset by id.
   * @param id - the preset id, or `undefined` for {@link defaultId}.
   * @returns the resolved preset.
   * @throws when no configured root supplies that id.
   */
  async resolve(id?: string): Promise<AgentPreset> {
    const wanted = id ?? this.config.default
    const presets = await this.list()
    const found = presets.find(preset => preset.id === wanted)
    if (found === undefined) {
      throw new UnknownPresetError(wanted, presets.map(preset => preset.id))
    }
    return found
  }

  /**
   * Compose one agent from a preset, installing it under that agent alone.
   *
   * Call from the agent factory's `setup(agentCtx)`; a rejection there rolls
   * the agent creation back, so a broken preset never yields a half-composed
   * session.
   * @param agentCtx - the agent's scope context.
   * @param id - the preset id, or `undefined` for {@link defaultId}.
   * @returns the preset that was mounted, for the caller to record.
   * @throws when the preset is unknown or its composition is unusable.
   */
  async mount(agentCtx: Context, id?: string): Promise<AgentPreset> {
    const preset = await this.resolve(id)
    await mountPreset(agentCtx, preset)
    return preset
  }

  /**
   * One agent's instance of a service its preset mounted.
   *
   * A preset publishes services behind `isolate` realms, which are invisible
   * outside the group that declares them — including to the host. This is how a
   * caller holding the agent reads one anyway: a request that is ABOUT a
   * session but arrives from outside it, which is every browser RPC.
   *
   * Read addressing only. A host row that `inject`s a service cannot use this,
   * because injection resolves before any session exists and has no agent to
   * key by; such a service belongs on the host plane instead.
   * @param agent - the agent whose composition to look inside.
   * @param name - the service name as the preset's rows resolve it.
   * @returns the agent's instance, or undefined when its preset mounts none.
   */
  serviceFor<K extends string & keyof Context>(agent: { ctx: Context }, name: K): Context[K] | undefined {
    return serviceForAgent(this.ctx, agent, name)
  }
}

export default AgentPresets
