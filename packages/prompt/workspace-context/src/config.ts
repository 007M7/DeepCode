/**
 * Configuration normalization for workspace instruction discovery and rendering.
 *
 * @module @deepseek-ai/dsh-workspace-context/config
 */

import z from 'schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-paths'

const DEFAULT_PROJECT_ROOT_MARKERS = ['.git'] as const
const DEFAULT_INSTRUCTION_FILE_CANDIDATES = ['AGENTS.md', 'CLAUDE.md'] as const
const DEFAULT_MAX_SOURCE_BYTES = 1_048_576
const RESERVED_PATH_SEGMENTS = new Set(['', '.', '..'])

/** User-facing workspace instruction loader configuration. */
export interface Config {
  /** Harness home containing the fixed user-global `AGENTS.md`; defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
  /** Directory entries that identify the project root while walking upward from the session cwd. */
  projectRootMarkers?: string[]
  /** UTF-8 byte cap for one rendered baseline or dynamic batch; non-positive or non-finite disables loading. */
  maxBytes: number
  /** Maximum UTF-8 bytes read from one instruction file; larger files are ignored. */
  maxSourceBytes?: number
  /** Ordered same-directory project candidates; the first existing regular file wins in each scope. */
  instructionFileCandidates?: string[]
}

export const Config: z<Config> = z.object({
  dshHome: z.string(),
  projectRootMarkers: z.array(z.string()).default([...DEFAULT_PROJECT_ROOT_MARKERS]),
  maxBytes: z.number().required(),
  maxSourceBytes: z.number().step(1).min(1).default(DEFAULT_MAX_SOURCE_BYTES),
  instructionFileCandidates: z.array(z.string()).default([...DEFAULT_INSTRUCTION_FILE_CANDIDATES]),
})

/** Normalized instruction discovery configuration. */
export interface ResolvedDiscoveryConfig {
  dshHome: string
  projectRootMarkers: string[]
  instructionFileCandidates: string[]
}

/** Normalized configuration used by discovery and reconciliation. */
export interface ResolvedConfig extends ResolvedDiscoveryConfig {
  maxBytes: number
  maxSourceBytes: number
}

/**
 * Resolve defaults, the harness home, and valid same-directory candidates.
 * @param config - user-facing plugin configuration.
 * @returns normalized runtime configuration.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  return {
    ...resolveDiscoveryConfig(config),
    maxBytes: config.maxBytes,
    maxSourceBytes: config.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES,
  }
}

/**
 * Resolve the subset of configuration used before instruction content is rendered.
 * @param config - optional discovery controls.
 * @returns normalized home, root markers, and instruction candidates.
 */
export function resolveDiscoveryConfig(
  config: Pick<Config, 'dshHome' | 'projectRootMarkers' | 'instructionFileCandidates'>,
): ResolvedDiscoveryConfig {
  return {
    dshHome: resolveDshHome(config.dshHome),
    projectRootMarkers: config.projectRootMarkers ?? [...DEFAULT_PROJECT_ROOT_MARKERS],
    instructionFileCandidates: resolveInstructionFileCandidates(config.instructionFileCandidates),
  }
}

function resolveInstructionFileCandidates(candidates: string[] | undefined): string[] {
  return (candidates ?? [...DEFAULT_INSTRUCTION_FILE_CANDIDATES]).filter(candidate => (
    !RESERVED_PATH_SEGMENTS.has(candidate) && !/[\\/]/.test(candidate)
  ))
}
