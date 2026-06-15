# AGENTS.md — Harness Packages

This directory contains all `@deepseek-ai/dsh-*` harness packages. When editing code here, follow these conventions:

- **Effect-based registrations**: every contribution (tool, section, adapter, agent, event listener) goes through `ctx.effect()` / `ctx.on()`, and `register()` methods return disposers. Never use bare arrays or manual cleanup.
- **Declaration merging**: services declare their ctx key in `declare module 'cordis' { interface Context { } }` and their events in `interface Events`. Merge-extensible maps (`ContentBlockMap`, `MessageSourceMap`, `FinishReasonMap`, `TurnTriggerMap`, `TurnEndReasonMap`, `SessionEventMap`) are how plugins add new variants.
- **Waterfall semantics**: `ctx.waterfall` listeners receive `(...args, next)`; call `next()` to delegate, or return without it to short-circuit (veto). Never call `next()` after returning.
- **Tests**: vitest in `packages/<name>/tests/*.spec.ts`. Every registry needs an HMR-safety test (register a plugin, dispose its fiber, assert cleanup). Err on the side of more tests — edge cases, error paths, event ordering, races.

Naming notes:
- Files `src/index.ts` export the service default + all public types
- `src/types.ts` contain only types — no runtime code
- Tests live at package level under `tests/`, not `src/__tests__/`
- A package's README and module/JSDoc comments are part of the change: when you alter behavior (config keys, defaults, error codes, wire fields), update them in the same commit. CI runs `yarn doc-sync`, which typechecks fenced `ts` blocks in `packages/*/README.md` and verifies the event-taxonomy table — but it does NOT cover this file or prose drift (config keys, defaults, error codes), so those stay on the author.

Read the per-package README.md for package-specific details: service API, events, extension points, TODOs.
