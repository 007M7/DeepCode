/**
 * Vocabulary for the spill storage seam. Types only — the abstract service
 * lives in `./index.ts`, implementations in sibling packages
 * (`@deepseek-ai/dsh-spill-local` first).
 *
 * @module @deepseek-ai/dsh-spill/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { CallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

/**
 * A local filesystem path produced by the spill seam, intended for the model's
 * `read` tool. The brand records that the path came from {@link SpillFiles.saveText}
 * (a runtime artifact, not a workspace file); it is still rendered to the model
 * as an ordinary path string in v1. A future remote/virtual backend may replace
 * this with a `spill://…` URI, so consumers treat it as opaque.
 */
export type SpillPath = Branded<'SpillPath'>

/**
 * Brand a string as a {@link SpillPath}.
 *
 * @param path The backend-produced path string to brand.
 * @returns The branded spill path.
 */
export function SpillPath(path: string): SpillPath {
  return path as SpillPath
}

/**
 * Who a spilled file belongs to: the session whose tool call produced it. The
 * backend scopes storage per session (its directory layout, its cleanup unit),
 * so the owner is the session id, not a decoupled token — spill is inherently
 * session-scoped, unlike the bash executor's cross-session `OwnerToken`.
 */
export interface SpillOwner {
  sessionId: SessionId
}

/**
 * Provenance of one spilled artifact — recorded by the backend for a readable
 * filename and future cleanup/inspection. Not interpreted for access control
 * (the {@link SpillOwner} scopes storage); purely descriptive.
 */
export interface SpillSource {
  /** The tool whose result was spilled (e.g. `web_fetch`). */
  toolName: string
  /** The model-issued call id the result belongs to. */
  callId: CallId
  /** A short human label for the artifact (e.g. `result`). */
  label: string
}

/** One request to persist text to a spill file. */
export interface SaveTextSpill {
  owner: SpillOwner
  source: SpillSource
  /**
   * A caller-suggested base name (e.g. `web_fetch.txt`). The backend sanitizes
   * it to a single safe path segment before use — it is a hint, never a path.
   */
  suggestedName: string
  /** The full text to persist (UTF-8). */
  content: string
}

/** A saved spill file: its path plus the byte length written. */
export interface SpillRef {
  path: SpillPath
  bytes: number
}
