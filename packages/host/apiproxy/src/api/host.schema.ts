/**
 * host domain zod schemas (names derived from map keys).
 */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import { imageMediaTypeSchema } from './sessions.schema.ts'

const modalitySchema = z.union([z.literal('text'), z.literal('image')])

/** host.describe request payload (empty object literal). */
export const hostDescribeRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'host.describe'>>>

/** host.describe response value. */
export const hostDescribeValueSchema = z.object({
  version: z.string(),
  cwd: z.string(),
  provider: z.string().optional(),
  model: z.string().optional(),
  activeModel: z.object({
    provider: z.string(),
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    inputModalities: z.array(modalitySchema).optional(),
    outputModalities: z.array(modalitySchema).optional(),
  }).optional(),
  imageLimits: z.object({
    maxImageBytes: z.number().int().positive(),
    maxImagesPerMessage: z.number().int().positive(),
    maxMessageImageBytes: z.number().int().positive(),
    maxImagePixels: z.number().int().positive(),
    mediaTypes: z.array(imageMediaTypeSchema),
  }).optional(),
  attachedSessions: z.number().int().nonnegative(),
}) satisfies z.ZodType<Wire<ResponseValue<'host.describe'>>>
