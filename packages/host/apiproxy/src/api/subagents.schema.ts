/** Zod schemas for the browser-safe subagent domain. */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import { contentBlockSchema, historyEntrySchema, sessionIdSchema } from './sessions.schema.ts'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SubagentListEntry } from './subagents.ts'

/** Healthy and diagnostic durable catalog rows. */
export const subagentListEntrySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('child'),
    id: sessionIdSchema,
    label: z.string(),
    activity: z.union([z.literal('running'), z.literal('inactive')]),
  }),
  z.object({
    kind: z.literal('diagnostic'),
    id: sessionIdSchema,
    reason: z.union([z.literal('corrupt'), z.literal('unsupported'), z.literal('unavailable')]),
  }),
]) satisfies z.ZodType<Wire<SubagentListEntry>>

/** subagent.list request payload. */
export const subagentListRequestSchema = z.object({
  parentSessionId: sessionIdSchema,
}) satisfies z.ZodType<Wire<RequestPayload<'subagent.list'>>>

/** subagent.list response value. */
export const subagentListValueSchema = z.object({
  entries: z.array(subagentListEntrySchema),
  parentAvailable: z.boolean(),
}) satisfies z.ZodType<Wire<ResponseValue<'subagent.list'>>>

/** subagent.history request payload. */
export const subagentHistoryRequestSchema = z.object({
  parentSessionId: sessionIdSchema,
  childSessionId: sessionIdSchema,
  beforeSeq: z.number().int().nonnegative().optional(),
  maxMessages: z.number().int().positive().optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'subagent.history'>>>

/** subagent.history response value. */
export const subagentHistoryValueSchema = z.object({
  events: z.array(historyEntrySchema),
  hasMore: z.boolean(),
}) as unknown as z.ZodType<Wire<ResponseValue<'subagent.history'>>>

/** subagent.prompt request payload. */
export const subagentPromptRequestSchema = z.object({
  parentSessionId: sessionIdSchema,
  childSessionId: sessionIdSchema,
  content: z.array(contentBlockSchema),
}) as unknown as z.ZodType<RequestPayload<'subagent.prompt'>>

const messageIdSchema = z.string() as unknown as z.ZodType<MessageId>

/** subagent.prompt response value. */
export const subagentPromptValueSchema = z.object({
  messageId: messageIdSchema,
}) satisfies z.ZodType<Wire<ResponseValue<'subagent.prompt'>>>
