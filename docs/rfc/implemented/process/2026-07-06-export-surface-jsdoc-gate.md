# RFC: Export-surface JSDoc gate

Status: implemented

## Problem

The [cordis JSDoc completeness gate](2026-07-04-cordis-jsdoc-completeness-gate.md) made undocumented parameters and results impossible on the cordis surface — `interface Events` members and `ctx.<key>` service classes — but that surface is a fraction of what a plugin author imports. The AGENTS.md rule "every export (and non-obvious method) has a JSDoc explaining semantics" stayed prose-checkable only by review everywhere else, and nothing at all asked for `@param`/`@returns` on ordinary exported functions. A survey at adoption found 203 under-documented module-level exports across 34 packages: seam-adjacent helpers (`runBash`, `readForEdit`, `htmlToMarkdown`), format codecs, whole undocumented interfaces and type aliases — exactly the names an IDE consumer hovers.

## Decision

A new gate, `scripts/verify-export-jsdoc.ts` (`pnpm run verify-export-jsdoc`, wired into `doc-sync` beside `verify-cordis-catalog`), walks every module-level exported name under each `packages/<group>/<pkg>/src/` tree. The parsing and check helpers moved from `gen-cordis-catalog.ts` into a shared `scripts/jsdoc.ts`, so "documented" means the same thing on both surfaces: description prose ends at the first block tag, every checkable parameter needs a non-empty `@param`, a non-void ANNOTATED return needs a non-empty `@returns`, a stale `@param` errors, and violations aggregate into one report.

The contract by declaration kind:

- Every exported name needs JSDoc with non-empty description prose.
- Function-like exports (function declarations; consts with function initializers or an INLINE function-type annotation; non-identifier function default exports) follow the full function contract. A const whose declarator is annotated with a NAMED type (`export const f: Handler = …`) defers the signature contract to that type's own declaration and `@returns` stays optional; an inline `(x: T) => U` annotation is the surface signature itself and gets the full contract.
- Exported classes need class-level prose; public methods (statics included — reachable on the exported name) follow the function contract; public properties and accessors need prose (a get/set pair is covered by the getter). Overload implementations are exempt — the signatures carry the docs.
- Exported interfaces, type aliases, and enums need prose on the declaration; member-level enforcement is deliberately deferred (the highest-value member surface — seam service classes — is already under the cordis gate).
- Exported namespaces recurse (inside an ambient `declare` namespace every member exports implicitly); the namespace itself needs prose only when it does not merge with a documented same-name declaration (the Config-namespace idiom documents the plugin once).
- `declare module` / `declare global` bodies, `export … from` re-export statements, and `export import X = N.member` aliases are skipped: an augmentation is not an export of the package, and a re-exported or aliased definition is checked where it is defined.
- Everything else fails CLOSED: `export =` is refused outright, and an exported statement kind the dispatch does not recognize is itself a violation — no export form can pass unchecked by omission.

Three exemption families keep the gate from demanding boilerplate, in the spirit of the cordis gate's `this`/`next` exemptions (documenting an exempt name anyway is allowed; only absence goes unchecked):

- **Heritage members.** A class member whose name exists on an `extends`/`implements` heritage type is exempt: the seam declaration is the doc's one home, and the IDE inherits it on hover — re-documenting every `LocalBashExecutor.run` invites drift. The exemption stops where the override grows surface the base never documented: a protected-only base member does not exempt a public override, and parameters the base never names keep their `@param` duty (an underscore-prefixed rename of a base parameter — the deliberately-unused marker — is the same parameter). This is the one question the walk asks the TYPE CHECKER (heritage types live across package boundaries, resolved through the repo `paths` map); everything else stays pure AST, and the annotated-return requirement is kept for symmetry with the cordis gate (it bound nothing at adoption — every exported function was already annotated).
- **Plugin-protocol slots.** Top-level `name` / `inject` / `reusable` / `Config` consts and the `apply` entry, plus the same slots as statics on a plugin class, are framework protocol: their shape is fixed by cordis, and the module doc comment plus the `interface Config` carry the plugin's real semantics.
- **Constructors**, mirroring the cordis gate: plugin classes are framework-constructed, and the class doc owns the story.

`collectExportJsdocViolations()` returns the violation list (the CLI exits 1 on non-empty) so the negative-path tests in `packages/core/agent/tests/verify-export-jsdoc.spec.ts` assert on findings directly, driving fixture packages through every rejection and every exemption.

## Alternatives considered

- **eslint-plugin-jsdoc** (`require-jsdoc`/`require-param`/`require-returns`) — covers the mechanical core but cannot express the repo's contract: the heritage-member exemption needs cross-package type resolution, the protocol-slot and namespace-merge idioms are cordis-specific, and the completeness semantics (prose-above-tags, stale-tag errors, aggregate reporting) already have one home in `scripts/jsdoc.ts` shared with the catalog generator. Two subtly different definitions of "documented" is the failure mode this repo's one-home rule exists to prevent.
- **Extending `gen-cordis-catalog.ts`** — the catalog generator renders a curated surface and gates its freshness; a repo-wide walk has no catalog to render. Sharing the helpers while keeping the walks separate keeps each gate's scope legible.
- **Enforcing interface/type-alias member docs** — deferred: it would multiply the checked surface for members that are largely self-describing fields, while the seam classes carrying the load-bearing member contracts are already gated. Revisit if member-doc drift shows up in review.

## Consequences

- A new export cannot land undocumented: `verify-export-jsdoc` fails `doc-sync`, which pre-push and CI already run. The 203 gaps found at adoption were filled in the same change, so the gate landed green.
- Exported functions must annotate return types (universal at adoption, now load-bearing) and use identifier parameters where `@param` must name them.
- Seam docs are canonical: an implementation inherits its heritage docs, and behavior notes worth keeping on the implementation are additions, not requirements.
- The gate builds a `ts.Program` (~6s) — the one doc gate that pays for type resolution; acceptable inside `doc-sync`, which already compiles doc snippets.
- The protocol-slot names are reserved by convention at module top level; a non-protocol export coincidentally named `apply` or `Config` would go unchecked — accepted, documented here.
