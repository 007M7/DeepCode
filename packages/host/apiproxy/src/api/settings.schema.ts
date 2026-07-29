/**
 * settings domain zod schemas (names derived from map keys: settingsDescribeRequestSchema /
 * settingsDescribeValueSchema / settingsUpdate* / settingsReplace*).
 */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import type { SettingsNamespaceView, SettingsSecretView } from './settings.ts'

/** One redacted secret slot. */
export const settingsSecretViewSchema = z.object({
  path: z.array(z.string()),
  set: z.boolean(),
}) satisfies z.ZodType<Wire<SettingsSecretView>>

/** SettingsNamespaceView row of settings.describe and the write responses. */
export const settingsNamespaceViewSchema = z.object({
  ns: z.string().min(1),
  schema: z.unknown(),
  value: z.unknown(),
  base: z.unknown().optional(),
  user: z.unknown().optional(),
  applies: z.union([z.literal('live'), z.literal('restart')]),
  secrets: z.array(settingsSecretViewSchema),
}) satisfies z.ZodType<Wire<SettingsNamespaceView>>

/** settings.describe request payload. */
export const settingsDescribeRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'settings.describe'>>>

/** settings.describe response value. */
export const settingsDescribeValueSchema = z.object({
  writable: z.boolean(),
  namespaces: z.array(settingsNamespaceViewSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'settings.describe'>>>

/** settings.update request payload. */
export const settingsUpdateRequestSchema = z.object({
  ns: z.string().min(1),
  patch: z.record(z.string(), z.unknown()),
}) satisfies z.ZodType<Wire<RequestPayload<'settings.update'>>>

/** settings.update response value: the namespace's new redacted view. */
export const settingsUpdateValueSchema = settingsNamespaceViewSchema satisfies z.ZodType<Wire<ResponseValue<'settings.update'>>>

/** settings.replace request payload. */
export const settingsReplaceRequestSchema = z.object({
  ns: z.string().min(1),
  section: z.record(z.string(), z.unknown()),
}) satisfies z.ZodType<Wire<RequestPayload<'settings.replace'>>>

/** settings.replace response value. */
export const settingsReplaceValueSchema = settingsNamespaceViewSchema satisfies z.ZodType<Wire<ResponseValue<'settings.replace'>>>
