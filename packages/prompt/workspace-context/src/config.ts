import z from 'schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-paths'

const DEFAULT_MAX_BYTES = 64 * 1024
const DEFAULT_PROJECT_ROOT_MARKERS = ['.git'] as const
const DEFAULT_INSTRUCTION_FILE_CANDIDATES = ['AGENTS.md', 'CLAUDE.md'] as const
const RESERVED_PATH_SEGMENTS = new Set(['', '.', '..'])

/** User-facing workspace instruction loader configuration. */
export interface Config {
  /** Harness home containing the fixed user-global `AGENTS.md`; defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
  /** Directory entries that identify the project root while walking upward from the session cwd. */
  projectRootMarkers?: string[]
  /** Maximum UTF-8 bytes in one rendered baseline or dynamic instruction batch; non-positive disables loading. */
  maxBytes?: number
  /** Ordered same-directory project candidates; the first existing regular file wins in each scope. */
  instructionFileCandidates?: string[]
}

export const Config: z<Config> = z.object({
  dshHome: z.string(),
  projectRootMarkers: z.array(z.string()).default([...DEFAULT_PROJECT_ROOT_MARKERS]),
  maxBytes: z.number().default(DEFAULT_MAX_BYTES),
  instructionFileCandidates: z.array(z.string()).default([...DEFAULT_INSTRUCTION_FILE_CANDIDATES]),
})

/** Fully defaulted configuration used by discovery and reconciliation. */
export interface ResolvedConfig {
  dshHome: string
  projectRootMarkers: string[]
  maxBytes: number
  instructionFileCandidates: string[]
}

/**
 * Resolve defaults, the harness home, and valid same-directory candidates.
 * @param config - user-facing plugin configuration.
 * @returns normalized runtime configuration.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  return {
    dshHome: resolveDshHome(config.dshHome),
    projectRootMarkers: config.projectRootMarkers ?? [...DEFAULT_PROJECT_ROOT_MARKERS],
    maxBytes: config.maxBytes ?? DEFAULT_MAX_BYTES,
    instructionFileCandidates: resolveInstructionFileCandidates(config.instructionFileCandidates),
  }
}

function resolveInstructionFileCandidates(candidates: string[] | undefined): string[] {
  return (candidates ?? [...DEFAULT_INSTRUCTION_FILE_CANDIDATES]).filter(candidate => (
    !RESERVED_PATH_SEGMENTS.has(candidate) && !/[\\/]/.test(candidate)
  ))
}
