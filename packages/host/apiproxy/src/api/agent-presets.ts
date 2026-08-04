/**
 * agent-presets domain contract: the roster a browser offers when starting a
 * session, plus the authoring calls behind it.
 *
 * `list` is ordinary: it carries ids and trust, and every preset picker needs
 * it. Everything else is privileged and loopback-pinned — a composition names
 * the plugins a session runs, so reading one is reconnaissance, writing one is
 * arbitrary capability, and selecting one can move a session onto a preset
 * that edits the live runtime.
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
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
   * every session shares the host composition. `authorable` reports whether
   * the deployment configures a root new presets can be written to, which is
   * a deployment fact rather than a per-preset one.
   */
  list(request: RpcRequest<{}>):
  Promise<RpcResponse<{ presets: readonly AgentPresetEntry[]; authorable: boolean }>>

  /**
   * Recompose one session's agent from a different preset.
   *
   * Allowed only while the session is blank — no turn has run. Once a
   * conversation starts, its history was produced under that preset's tools,
   * and swapping them would leave logged tool calls the new composition cannot
   * make; the attempt answers `agent-preset-locked`.
   */
  select(request: RpcRequest<{ sessionId: SessionId; agentPreset: string }>):
  Promise<RpcResponse<{ agentPreset: string }>>

  /**
   * Read one preset's composition text, for an editor.
   *
   * Privileged: a composition names the plugins a session runs, so reading one
   * is reconnaissance and writing one is arbitrary capability.
   */
  read(request: RpcRequest<{ agentPreset: string }>):
  Promise<RpcResponse<{ agentPreset: string; trust: 'system' | 'user'; content: string; writable: boolean }>>

  /**
   * Create or replace a locally authored preset. Shipped presets are refused;
   * the text is shape-checked before it lands, so a save cannot leave a file no
   * session could load.
   */
  write(request: RpcRequest<{ agentPreset: string; content: string }>):
  Promise<RpcResponse<{ agentPreset: string }>>

  /** Delete a locally authored preset. Shipped presets are refused. */
  remove(request: RpcRequest<{ agentPreset: string }>): Promise<RpcResponse<{}>>
}
