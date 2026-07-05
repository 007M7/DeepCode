/**
 * The model-facing filesystem tool suite (`read`, `write`, `edit`) over the
 * `ctx.fs` provider seam. This single plugin registers all three tools.
 *
 * ## The tool is the executor; policy is an event gate
 *
 * The tool reads/writes/edits through `ctx.fs` DIRECTLY and owns model-facing
 * concerns only — tool names, JSON schemas, argument validation, prompt
 * sections, read windowing, result formatting. It does NOT inject a policy
 * service. Instead, on each write/edit it dispatches a single-slot waterfall
 * (`fs/write-intent`/`fs/edit-intent`) to obtain the OPTIONAL version guard, and
 * after every read/write/edit it emits `fs/observed` with a plain (unguarded)
 * `ctx.emit`. A policy plugin (`@deepseek-ai/dsh-fs-policy`) occupies the
 * decision slot and listens for `fs/observed` to add observed-state +
 * read-before-edit + version-guarded write/edit; a deployment that loads these
 * tools is expected to also load it. With no policy plugin the waterfalls fall
 * through to their `undefined` default (the unconstrained bare provider) and
 * `fs/observed` is unheard — the tool still functions. This package never
 * imports `node:fs`, `node:path`, or an `@deepseek-ai/dsh-fs-local`
 * implementation.
 *
 * @module @deepseek-ai/dsh-tool-fs
 */

import type { Context } from 'cordis'
import z from 'schemastery'
import { applyReadTool, READ_LIMIT, STREAM_MIN_SIZE } from './read.ts'
import { applyWriteTool } from './write.ts'
import { applyEditTool } from './edit.ts'
import { READ_MAX_BYTES, READ_MAX_LINE_LENGTH } from './read-render.ts'

export { READ_LIMIT, STREAM_MIN_SIZE, applyReadTool, parseReadArgs } from './read.ts'
export type { ReadToolCaps } from './read.ts'
export { applyWriteTool, formatWriteOutput, parseWriteArgs } from './write.ts'
export { applyEditTool, formatEditOutput, parseEditArgs } from './edit.ts'
export { READ_MAX_BYTES, READ_MAX_LINE_LENGTH, buildWindow, formatReadOutput } from './read-render.ts'
export type { FileReadOutcome, FileTextLine, ReadWindow, WindowResult } from './read-render.ts'
export { DIFF_CONTEXT, computeHunkDiffs, diffsFromMeta } from './diff.ts'
export type { FsDiffMeta } from './diff.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-fs'

/** Services required by the filesystem tool suite. */
export const inject = ['tools', 'fs', 'systemPrompt']

/** Plugin config (all optional — `Config` supplies the defaults). */
export interface Config {
  /** Default and maximum number of lines returned by one `read` call. */
  readLimit?: number
  /** Maximum characters returned for a single line before truncation. */
  readMaxLineLength?: number
  /** Maximum bytes returned for the selected lines of one `read` call. */
  readMaxBytes?: number
  /** Files at or above this size stream instead of loading whole into memory. */
  readStreamMinSize?: number
}

export const Config: z<Config> = z.object({
  readLimit: z.number().default(READ_LIMIT),
  readMaxLineLength: z.number().default(READ_MAX_LINE_LENGTH),
  readMaxBytes: z.number().default(READ_MAX_BYTES),
  readStreamMinSize: z.number().default(STREAM_MIN_SIZE),
})

/** The shape after schemastery applied the defaults. */
type ResolvedConfig = Required<Config>

/** Every read cap counts lines/chars/bytes — a positive integer, or windowing arithmetic misbehaves silently. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-fs: ${name} must be a positive integer`)
  }
}

/** Register the full `read`/`write`/`edit` filesystem tool suite. */
export function apply(ctx: Context, config: Config): void {
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as ResolvedConfig
  assertPositiveInteger('readLimit', resolved.readLimit)
  assertPositiveInteger('readMaxLineLength', resolved.readMaxLineLength)
  assertPositiveInteger('readMaxBytes', resolved.readMaxBytes)
  assertPositiveInteger('readStreamMinSize', resolved.readStreamMinSize)
  applyReadTool(ctx, {
    limit: resolved.readLimit,
    maxLineLength: resolved.readMaxLineLength,
    maxBytes: resolved.readMaxBytes,
    streamMinSize: resolved.readStreamMinSize,
  })
  applyWriteTool(ctx)
  applyEditTool(ctx)
}
