/**
 * Runtime mirror of the cordis `FiberState` const enum plus human-readable
 * labels, shared by the mount lifecycle (state reporting) and the inspect
 * renderers (plugin-list and mount-table labels).
 *
 * Cordis exposes `FiberState` as a `const enum`: there is no runtime object for
 * Node's type-stripping runner to import, so the members are mirrored here as
 * values — each typed (via the type-only import) as the cordis enum member it
 * mirrors, so enum-typed reads like `fiber.state` compare against them under a
 * shared enum type. Source of truth: vendor/cordis/src/fiber.ts (pinned; drift
 * only happens through a deliberate vendor sync).
 *
 * @module @deepseek-ai/dsh-tool-cordis/fiber-state
 */

import type { FiberState as FiberStateEnum } from 'cordis'

/** Value mirror of the cordis `FiberState` const enum (see the module doc for why a mirror exists). */
export const FiberState = {
  PENDING: 0 as FiberStateEnum.PENDING,
  LOADING: 1 as FiberStateEnum.LOADING,
  ACTIVE: 2 as FiberStateEnum.ACTIVE,
  FAILED: 3 as FiberStateEnum.FAILED,
  DISPOSED: 4 as FiberStateEnum.DISPOSED,
  UNLOADING: 5 as FiberStateEnum.UNLOADING,
} as const

/** The cordis `FiberState` enum type, re-exported so mirror consumers need one import. */
export type FiberState = FiberStateEnum

/** Human-readable label for each {@link FiberState}, keyed by member (inlining-safe — no reverse mapping). */
export const STATE_LABELS: Record<FiberState, string> = {
  [FiberState.PENDING]: 'pending',
  [FiberState.LOADING]: 'loading',
  [FiberState.ACTIVE]: 'active',
  [FiberState.FAILED]: 'failed',
  [FiberState.DISPOSED]: 'disposed',
  [FiberState.UNLOADING]: 'unloading',
}
