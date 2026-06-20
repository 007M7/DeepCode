/**
 * The `Branded<B>` nominal-typing primitive — a type-only utility (no runtime
 * code, no harness-package dependency) shared by every package that owns a
 * cross-boundary id.
 *
 * A brand makes structurally-identical strings non-interchangeable at the type
 * level: an `AgentId` cannot be passed where a `CallId` is expected, even
 * though both are plain strings at runtime. Construction goes through a per-id
 * factory in the OWNING package (a plain cast inside — zero runtime cost);
 * comparison, logging, and serialization all behave as ordinary strings.
 *
 * Policy: a package brands the ids it owns — `CallId` in dsh-llm (tool-call
 * correlation), `SessionId` in dsh-session, `AgentId` in dsh-agent,
 * `BashTaskId`/`OwnerToken` in dsh-bash. Branding is for ids that cross package
 * boundaries and could plausibly be confused; not every string needs a brand.
 * This package owns ONLY the primitive — no concrete id, no runtime code beyond
 * the (erased) type — so the brand vocabulary stays dependency-free and a
 * package can brand its ids without depending on an unrelated capability
 * package (e.g. dsh-bash brands its ids without pulling in dsh-llm).
 *
 * @module @deepseek-ai/dsh-brand
 */

declare const BRAND: unique symbol

/** A string carrying a compile-time-only brand `B`. */
export type Branded<B extends string> = string & { readonly [BRAND]: B }
