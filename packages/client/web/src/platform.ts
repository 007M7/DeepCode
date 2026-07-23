/**
 * Platform singletons the shell shares into the module table.
 * Single source of truth (design §3.3, contract C1): seed keys = tsdown
 * client externals = the shared surface. The three projections import this
 * module — the seed table ({@link ../seed.ts}), the tsdown client preset's
 * external judgement (packages/client/tsdown.client.ts), and the vite alias
 * check — so the list cannot drift between them.
 * @module @deepseek-ai/dsh-client-web/src/platform
 */

/** The module specifiers the shell shares into the frozen module table. */
export const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', 'cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
] as const

/** One platform module specifier (a seed-table key). */
export type PlatformModule = (typeof PLATFORM_MODULES)[number]
