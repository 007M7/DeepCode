/**
 * The `Branded<B>` nominal-typing primitive — a type-only utility (no runtime code, no
 * harness-package dependency) shared by every package that owns a cross-boundary id.
 * @module @deepseek-ai/dsh-brand
 */

declare const BRAND: unique symbol

/** A string carrying a compile-time-only brand `B`. */
export type Branded<B extends string> = string & { readonly [BRAND]: B }
