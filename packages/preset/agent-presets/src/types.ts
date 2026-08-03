/** Agent-preset vocabulary shared by discovery, mounting, and consumers. @module @deepseek-ai/dsh-agent-presets/types */

/**
 * Where a preset's composition came from. A `system` preset ships with the
 * deployment; a `user` preset was authored locally, by a person or by an
 * agent, and therefore carries the same trust as shell access.
 */
export type PresetTrust = 'system' | 'user'

/** One preset directory that carries a mountable agent composition. */
export interface AgentPreset {
  /** Stable identifier; the preset directory's name. */
  readonly id: string
  /** Trust recorded from the root this preset was discovered under. */
  readonly trust: PresetTrust
  /** Absolute path of the preset's agent composition file. */
  readonly path: string
}

/** One directory scanned for preset subdirectories. */
export interface PresetRoot {
  /** Directory holding one subdirectory per preset; a leading `~` expands. */
  path: string
  /** Trust recorded on every preset discovered under this root. */
  trust: PresetTrust
}

/** Plugin config: which preset is the default, and where presets live. */
export interface Config {
  /** Preset id mounted when a caller names none. Missing at mount time fails loud. */
  default: string
  /** Scanned roots in precedence order; an earlier root wins a duplicate id. */
  roots: PresetRoot[]
}
