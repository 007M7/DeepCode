/**
 * goals domain zod schemas.
 */

import { z } from 'zod'
import type { Wire } from './rpc.schema.ts'
import type { GoalRef, GoalView, RequestPayload, ResponseValue } from './index.ts'

/** GoalRef schema. */
export const goalRefSchema = z.object({
  id: z.string(),
  revision: z.number().int().positive(),
}) as unknown as z.ZodType<Wire<GoalRef>>

/** Goal block reason schema. */
export const goalBlockReasonSchema = z.object({
  code: z.string(),
  message: z.string(),
})

/** GoalView schema. */
export const goalViewSchema = z.object({
  id: z.string(),
  revision: z.number().int().positive(),
  objective: z.string(),
  phase: z.union([z.literal('active'), z.literal('paused'), z.literal('blocked'), z.literal('complete')]),
  blockedReason: goalBlockReasonSchema.optional(),
  maxGoalRounds: z.number().int().positive(),
  roundsStarted: z.number().int().nonnegative(),
  createdAt: z.number(),
  updatedAt: z.number(),
  activation: z.union([z.literal('armed'), z.literal('disarmed')]),
}) as unknown as z.ZodType<Wire<GoalView>>

/** goal.create request payload. */
export const goalCreateRequestSchema = z.object({
  sessionId: z.string(),
  objective: z.string().min(1),
  maxGoalRounds: z.number().int().positive().optional(),
}) as unknown as z.ZodType<Wire<RequestPayload<'goal.create'>>>

/** goal.create response value. */
export const goalCreateValueSchema = z.object({
  goal: goalViewSchema,
}) as unknown as z.ZodType<Wire<ResponseValue<'goal.create'>>>

/** goal.edit request payload. */
export const goalEditRequestSchema = z.object({
  sessionId: z.string(),
  ref: goalRefSchema,
  objective: z.string().min(1).optional(),
  maxGoalRounds: z.number().int().positive().optional(),
}).refine(value => value.objective !== undefined || value.maxGoalRounds !== undefined, {
  message: 'goal.edit requires objective or maxGoalRounds',
}) as unknown as z.ZodType<Wire<RequestPayload<'goal.edit'>>>

/** goal.edit response value. */
export const goalEditValueSchema = z.object({
  goal: goalViewSchema,
}) as unknown as z.ZodType<Wire<ResponseValue<'goal.edit'>>>

/** goal.pause request payload. */
export const goalPauseRequestSchema = z.object({
  sessionId: z.string(),
  ref: goalRefSchema,
}) as unknown as z.ZodType<Wire<RequestPayload<'goal.pause'>>>

/** goal.pause response value. */
export const goalPauseValueSchema = z.object({
  goal: goalViewSchema,
}) as unknown as z.ZodType<Wire<ResponseValue<'goal.pause'>>>

/** goal.resume request payload. */
export const goalResumeRequestSchema = z.object({
  sessionId: z.string(),
  ref: goalRefSchema,
}) as unknown as z.ZodType<Wire<RequestPayload<'goal.resume'>>>

/** goal.resume response value. */
export const goalResumeValueSchema = z.object({
  goal: goalViewSchema,
}) as unknown as z.ZodType<Wire<ResponseValue<'goal.resume'>>>

/** goal.complete request payload. */
export const goalCompleteRequestSchema = z.object({
  sessionId: z.string(),
  ref: goalRefSchema,
}) as unknown as z.ZodType<Wire<RequestPayload<'goal.complete'>>>

/** goal.complete response value. */
export const goalCompleteValueSchema = z.object({
  goal: goalViewSchema,
}) as unknown as z.ZodType<Wire<ResponseValue<'goal.complete'>>>

/** goal.clear request payload. */
export const goalClearRequestSchema = z.object({
  sessionId: z.string(),
  ref: goalRefSchema,
}) as unknown as z.ZodType<Wire<RequestPayload<'goal.clear'>>>

/** goal.clear response value. */
export const goalClearValueSchema = z.object({
  cleared: z.literal(true),
}) as unknown as z.ZodType<Wire<ResponseValue<'goal.clear'>>>
