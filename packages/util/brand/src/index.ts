/**
 * Dependency-free nominal typing for cross-boundary identifiers. Structurally identical runtime
 * strings become non-interchangeable statically while retaining ordinary comparison, logging, and
 * serialization. Each owning package defines its concrete id and zero-cost factory; brand ids that
 * can plausibly be confused across packages, not arbitrary strings. This package exports only the
 * erased primitive so an owner need not depend on another capability package.
 * @module @deepseek-ai/dsh-brand
 */

declare const BRAND: unique symbol

/** A string carrying a compile-time-only brand `B`. */
export type Branded<B extends string> = string & { readonly [BRAND]: B }
