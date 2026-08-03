/**
 * agent-presets domain contract: the roster a browser offers when starting a
 * session. Read-only — a preset is a composition on disk, and authoring one is
 * a filesystem act rather than an RPC.
 */

import type { RpcRequest, RpcResponse } from './rpc.ts'

/** One preset the deployment can compose a session's agent from. */
export interface AgentPresetEntry {
  /** Stable identifier, also the display name until presets carry metadata. */
  readonly id: string
  /**
   * Whether the preset ships with the deployment or was authored locally.
   * A `user` preset is exactly as privileged as the plugins it names, so a
   * surface offering one should say so rather than present it as vetted.
   */
  readonly trust: 'system' | 'user'
  /** Whether a session that names no preset gets this one. */
  readonly isDefault: boolean
}

/** agent-preset-domain unary methods (the map key agentPreset.* of RpcMethodMap). */
export interface AgentPresetsApi {
  /**
   * Lists every preset the deployment currently supplies, ordered by id.
   * An empty roster means the deployment composes no presets at all, and
   * every session shares the host composition.
   */
  list(request: RpcRequest<{}>): Promise<RpcResponse<{ presets: readonly AgentPresetEntry[] }>>
}
