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
import type {
  HistoryEntry, ModelCatalogFailure, ModelCatalogModel, ModelProviderGroup, ModelReasoning,
  ModelReasoningEffort, ModelTarget, SessionProjectionsBlock, SessionSummary,
} from './sessions.ts'
import type { ToolEventView } from './events.ts'
import type { WorkspaceId } from './workspace.ts'

/** SessionId: one brand cast after shape validation (the only cast point in this domain). */
export const sessionIdSchema = z.string().min(1) as unknown as z.ZodType<SessionId>

/**
 * WorkspaceId: the workspace domain's one brand cast. Hosted here rather
 * than in workspace.schema because session.create references it while
 * workspace.schema references sessionIdSchema — schema modules must stay a
 * DAG (both casts used at module top level; a cycle is a load-time TDZ).
 */
export const workspaceIdSchema = z.string().min(1) as unknown as z.ZodType<WorkspaceId>

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
  blank: z.boolean(),
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

/** session.create request payload (at most one of workspaceId / cwd). */
export const sessionCreateRequestSchema = z.object({
  workspaceId: workspaceIdSchema.optional(),
  cwd: z.string().optional(),
  sessionId: sessionIdSchema.optional(),
}).refine(
  payload => payload.workspaceId === undefined || payload.cwd === undefined,
  { message: 'session.create accepts workspaceId or cwd, not both' },
) satisfies z.ZodType<Wire<RequestPayload<'session.create'>>>

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

/** Complete provider/model target. */
export const modelTargetSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1).optional(),
}) satisfies z.ZodType<Wire<ModelTarget>>

/** One adapter-owned reasoning effort. */
export const modelReasoningEffortSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
}) satisfies z.ZodType<Wire<ModelReasoningEffort>>

/** Exact-model reasoning metadata. */
export const modelReasoningSchema = z.object({
  efforts: z.array(modelReasoningEffortSchema).min(1),
  defaultEffort: z.string().min(1).optional(),
}) satisfies z.ZodType<Wire<ModelReasoning>>

/** One advisory model entry inside a provider group. */
export const modelCatalogModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  unlisted: z.literal(true).optional(),
  reasoning: modelReasoningSchema.optional(),
}) satisfies z.ZodType<Wire<ModelCatalogModel>>

/** One successfully loaded provider group. */
export const modelProviderGroupSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  models: z.array(modelCatalogModelSchema),
}) satisfies z.ZodType<Wire<ModelProviderGroup>>

/** One provider-local catalog failure. */
export const modelCatalogFailureSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  message: z.string(),
}) satisfies z.ZodType<Wire<ModelCatalogFailure>>

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

/**
 * Projection baseline passthrough: `values` stays a wide record — each value
 * was already parsed by its provider's own schema on the host side, and
 * deep-validating here would import every domain's schema into the carrier.
 */
export const sessionProjectionsBlockSchema = z.object({
  // -1 = empty log (the lastSeq convention of session/subscribed).
  asOfSeq: z.number().int().min(-1),
  values: z.record(z.string(), z.unknown()),
}) as unknown as z.ZodType<SessionProjectionsBlock>

/** session.history response value (projections rides the tail page only). */
export const sessionHistoryValueSchema = z.object({
  events: z.array(historyEntrySchema),
  hasMore: z.boolean(),
  projections: sessionProjectionsBlockSchema.optional(),
}) satisfies z.ZodType<Wire<ResponseValue<'session.history'>>>

/** session.models request payload. */
export const sessionModelsRequestSchema = z.object({
  sessionId: sessionIdSchema,
}) satisfies z.ZodType<Wire<RequestPayload<'session.models'>>>

/** session.models response value. */
export const sessionModelsValueSchema = z.object({
  current: modelTargetSchema,
  groups: z.array(modelProviderGroupSchema),
  failures: z.array(modelCatalogFailureSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'session.models'>>>

/** session.selectModel request payload. */
export const sessionSelectModelRequestSchema = z.object({
  sessionId: sessionIdSchema,
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1).optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'session.selectModel'>>>

/** session.selectModel response value. */
export const sessionSelectModelValueSchema = z.object({
  selected: modelTargetSchema,
}) satisfies z.ZodType<Wire<ResponseValue<'session.selectModel'>>>

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
