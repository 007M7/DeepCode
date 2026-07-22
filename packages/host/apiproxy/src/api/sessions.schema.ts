/**
 * sessions domain zod schemas (names derived from map keys: sessionListRequestSchema /
 * sessionListValueSchema). SessionEvent passthrough = strict envelope (type/seq/time) + wide
 * data: the merge-extensible event surface keeps an unknown-type branch at the union level,
 * with no field-level passthrough. SessionId brand cast point: sessionIdSchema, and only there.
 */

import { z } from 'zod'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import type { HistoryEntry, SessionSummary } from './sessions.ts'
import type { ToolEventView } from './events.ts'

/** SessionId: one brand cast after shape validation (the only cast point in this domain). */
export const sessionIdSchema = z.string().min(1) as unknown as z.ZodType<SessionId>

/** SessionEvent passthrough: strict envelope, wide data (the client fold handles unknown types via its documented default). */
export const sessionEventSchema = z.object({
  type: z.string(),
  seq: z.number().int().nonnegative(),
  time: z.number(),
  data: z.unknown(),
  sourceEventSeqs: z.array(z.number()).optional(),
  surfaceOp: z.unknown().optional(),
}) as unknown as z.ZodType<SessionEvent>

/** SessionSummary row of session.list. */
export const sessionSummarySchema = z.object({
  sessionId: sessionIdSchema,
  updatedAt: z.number(),
  running: z.boolean(),
  parentSessionId: sessionIdSchema.optional(),
  cwd: z.string().optional(),
}) satisfies z.ZodType<Wire<SessionSummary>>

/** session.list request payload (cursor is a reserved seat, unimplemented in v1). */
export const sessionListRequestSchema = z.object({
  cursor: z.string().optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'session.list'>>>

/** session.list response value. */
export const sessionListValueSchema = z.object({
  items: z.array(sessionSummarySchema),
}) satisfies z.ZodType<Wire<ResponseValue<'session.list'>>>

/** session.create request payload. */
export const sessionCreateRequestSchema = z.object({
  cwd: z.string().optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'session.create'>>>

/** session.create response value. */
export const sessionCreateValueSchema = z.object({
  sessionId: sessionIdSchema,
}) satisfies z.ZodType<Wire<ResponseValue<'session.create'>>>

/** session.history request payload (beforeSeq/maxMessages page backwards from the window tail). */
export const sessionHistoryRequestSchema = z.object({
  sessionId: sessionIdSchema,
  beforeSeq: z.number().int().nonnegative().optional(),
  maxMessages: z.number().int().positive().optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'session.history'>>>

/**
 * ToolEventView passthrough: lock only the `for` discriminant and the presence
 * of a card-tagged `view` object. The view interior is a host-computed product
 * the client reads without echoing back; deep-validating it would hand-copy
 * the dsh-tools vocabulary into this schema and drift with it.
 */
export const toolEventViewSchema = z.discriminatedUnion('for', [
  z.object({ for: z.literal('call'), view: z.looseObject({ card: z.string() }) }),
  z.object({ for: z.literal('result'), view: z.looseObject({ card: z.string() }) }),
]) as unknown as z.ZodType<ToolEventView>

/** One session.history item: the session event plus its optional host-computed tool view. */
export const historyEntrySchema = z.object({
  event: sessionEventSchema,
  view: toolEventViewSchema.optional(),
}) satisfies z.ZodType<Wire<HistoryEntry>>

/** session.history response value. */
export const sessionHistoryValueSchema = z.object({
  events: z.array(historyEntrySchema),
  hasMore: z.boolean(),
}) satisfies z.ZodType<Wire<ResponseValue<'session.history'>>>

/** ContentBlock passthrough: core is merge-extensible — the type discriminant envelope is strict, the rest stays wide. */
export const contentBlockSchema = z.looseObject({ type: z.string() })

/** session.prompt request payload. */
export const sessionPromptRequestSchema = z.object({
  sessionId: sessionIdSchema,
  mode: z.union([z.literal('queue'), z.literal('steer')]),
  content: z.array(contentBlockSchema),
}) as unknown as z.ZodType<RequestPayload<'session.prompt'>>

/** session.prompt response value. */
export const sessionPromptValueSchema = z.object({
  accepted: z.literal(true),
}) satisfies z.ZodType<Wire<ResponseValue<'session.prompt'>>>

/** session.cancel request payload. */
export const sessionCancelRequestSchema = z.object({
  sessionId: sessionIdSchema,
}) satisfies z.ZodType<Wire<RequestPayload<'session.cancel'>>>

/** session.cancel response value. */
export const sessionCancelValueSchema = z.object({
  accepted: z.literal(true),
}) satisfies z.ZodType<Wire<ResponseValue<'session.cancel'>>>
