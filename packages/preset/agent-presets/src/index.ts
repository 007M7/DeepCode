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
import { scopeOf } from '@deepseek-ai/dsh-scope'
import z from 'schemastery'
import { settingsNamespace, type SettingsScope, type default as SettingsService } from '@deepseek-ai/dsh-settings'
import { discoverPresets } from './discovery.ts'
import { deleteComposition, readComposition, writeComposition } from './authoring.ts'
import type { PresetMetadata } from './metadata.ts'
import { mountPreset, serviceForAgent, unmountPresetFor } from './mount.ts'
import { PresetNotWritableError } from './authoring.ts'
import { UnknownPresetError, type AgentPreset, type Config } from './types.ts'

/** Settings namespace carrying the user's chosen default preset. */
export const SETTINGS_NAMESPACE = 'agent-presets'

/** The user-writable slice of this plugin's config. */
export interface AgentPresetSettings {
  /** Preset mounted when a session names none. */
  default?: string
}

/** Runtime schema for the user-writable slice. */
export const AgentPresetSettingsSchema: z<AgentPresetSettings> = z.object({
  default: z.string(),
})

export { COMPOSITION_FILE, discoverPresets, scanRoot } from './discovery.ts'
export {
  METADATA_FILE, readPresetMetadata, renderPresetMetadata, type PresetMetadata,
} from './metadata.ts'
export {
  inactiveRows, leakedServices, livePresetMounts, mountPreset, serviceForAgent,
  unmountPresetFor, type PresetMount,
} from './mount.ts'
export {
  assertComposition, deleteComposition, InvalidCompositionError, InvalidPresetIdError,
  PresetNotWritableError, readComposition, writableRoot, writeComposition,
} from './authoring.ts'
export { resolveSessionPreset, type PresetBearingSession } from './session.ts'
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

  /**
   * The user layer over `config.default`, present only while a settings
   * provider is composed. Held rather than snapshotted so a hot-reloaded
   * document takes effect without a restart.
   */
  private settings: SettingsScope<AgentPresetSettings> | undefined

  /**
   * The settings service behind {@link settings}, held for the one write this
   * service makes: clearing a user default it has just deleted.
   */
  private settingsService: SettingsService | undefined

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'agentPresets')
    // Deliberately not `installSettingsSection`: that helper exists to re-judge
    // what a consumer DERIVED from the source — memoized resolutions,
    // registration-level facts — across attach, detach, and change. Nothing
    // here is derived. `defaultId` reads through on every call, so both of its
    // hooks would be no-ops and the source thunk would restate this field.
    ctx.inject(['settings'], (settingsCtx) => {
      this.settings = settingsCtx.settings.register(
        settingsNamespace(SETTINGS_NAMESPACE),
        AgentPresetSettingsSchema,
        { base: { default: config.default } },
      )
      this.settingsService = settingsCtx.settings
      settingsCtx.effect(() => () => {
        this.settings = undefined
        this.settingsService = undefined
      }, 'agentPresets.settings()')
    })
  }

  /**
   * The preset id mounted when a caller names none.
   *
   * Read per call rather than cached: the settings document is hot-reloaded, so
   * changing the default takes effect on the next session created and leaves
   * every running session on the preset it was composed from.
   */
  get defaultId(): string {
    return this.settings?.get().default ?? this.config.default
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
    const wanted = id ?? this.defaultId
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

  /** Whether this deployment configures a root locally authored presets go to. */
  get authorable(): boolean {
    return this.config.roots.some(root => root.trust === 'user')
  }

  /**
   * Read one preset's composition text.
   * @param id - the preset id.
   * @returns the composition exactly as stored.
   * @throws when no configured root supplies that id.
   */
  async read(id: string): Promise<string> {
    return await readComposition(await this.resolve(id))
  }

  /**
   * Create or replace a locally authored preset.
   *
   * The text is shape-checked before it lands, so a save cannot leave a file no
   * session could load; it is NOT mounted, so a composition that parses but
   * names a missing plugin still fails at the next session that selects it.
   * @param id - the preset id, which becomes its directory name.
   * @param content - the composition text.
   * @param metadata - display name and description; clearing both removes the file.
   * @throws when the id is unusable, the text is not an entry list, or the
   * deployment configures no writable root.
   */
  async write(id: string, content: string, metadata: PresetMetadata = {}): Promise<void> {
    // A shipped preset belongs to the deployment: overwriting it would remove
    // the known-good composition a broken local one is compared against.
    const existing = (await this.list()).find(preset => preset.id === id)
    if (existing !== undefined && existing.trust !== 'user') {
      throw new PresetNotWritableError(id, 'it ships with the deployment')
    }
    await writeComposition(this.config.roots, id, content, metadata)
  }

  /**
   * Delete a locally authored preset.
   * @param id - the preset id.
   * @throws when the preset is unknown or ships with the deployment.
   */
  async remove(id: string): Promise<void> {
    await deleteComposition(this.config.roots, await this.resolve(id))
    // Storing a default that does not exist YET is deliberate — the roster is a
    // live directory, so a name absent now may exist by the time a session asks
    // for it, and `resolve` reports it then. A default this call just deleted is
    // not that case: nothing will ever supply it again, and left in place every
    // session created without an explicit pick would fail to start. Clearing it
    // exposes the deployment's own default underneath, which is the layering.
    if (this.settings?.get().default !== id) return
    await this.settingsService?.mutate(
      settingsNamespace(SETTINGS_NAMESPACE),
      [{ op: 'unset', path: ['default'] }],
    )
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

  /**
   * Replace the composition installed for one agent.
   *
   * Only valid while the agent has produced nothing: swapping tools mid
   * conversation would leave logged tool calls the new composition cannot make.
   * The CALLER owns that check — this method does not read session history.
   *
   * The swap is unmount-then-mount because two compositions cannot coexist:
   * both would register the same tool names into one layer. A failed mount
   * therefore restores the previous composition rather than leaving the agent
   * with nothing.
   * @param agentCtx - the agent's scope context.
   * @param id - the preset to compose the agent from instead.
   * @returns the preset now installed.
   * @throws when the preset is unknown or its composition is unusable; the
   * previous composition is restored first.
   */
  async recompose(agentCtx: Context, id: string): Promise<AgentPreset> {
    const scope = scopeOf(agentCtx)
    if (scope === undefined) {
      throw new Error('agent-presets: refusing to recompose an unscoped context')
    }
    // Resolve before tearing anything down, so an unknown id leaves the agent
    // exactly as it was.
    const preset = await this.resolve(id)
    const previous = await unmountPresetFor(scope)
    try {
      await mountPreset(agentCtx, preset)
    } catch (error) {
      if (previous !== undefined) {
        // Restored unconditionally, same id included: the roster is a live
        // directory, so "the same inputs that worked a moment ago" does not
        // hold — the file may have changed between the original mount and
        // this one, which is exactly how a same-id reselect fails. Skipping
        // the restore there left the agent with no composition at all.
        await this.mount(agentCtx, previous).catch(() => {
          // The agent now has no composition, but the switch failure below is
          // the actionable diagnostic; reporting the restore's instead would
          // hide why the switch was attempted and what the operator must fix.
        })
      }
      throw error
    }
    return preset
  }
}

export default AgentPresets
