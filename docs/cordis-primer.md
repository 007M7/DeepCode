# Cordis Primer

Cordis is the vendored plugin framework underneath the DeepSeek Harness SDK. This primer teaches the Cordis ideas a harness plugin author needs before reading the generated [events](cordis-catalog/events.md) and [services](cordis-catalog/services.md) catalogs. The vendored source and sync procedure live in [vendor/README.md](../vendor/README.md).

## Cordis In Five Ideas

- **A plugin is a unit of behavior.** It can be a function with optional `inject` and `apply(ctx)` fields, or a `Service` subclass whose lifecycle Cordis mounts into the current context.
- **A context is the service container.** A service claims a stable `ctx.<key>` such as `ctx.tools`, `ctx.llm`, or `ctx.sessions`; other plugins program against that key instead of importing a concrete implementation.
- **`inject` is the dependency gate.** A plugin that names required services waits until those services exist, so load order is expressed through service requirements rather than manual boot sequencing.
- **Events are typed extension seams.** Services declare event names through TypeScript declaration merging, then dispatch them as `emit`, `waterfall`, `parallel`, or `serial` depending on whether listeners observe, wrap, fan out, or run in order.
- **Registrations are disposable effects.** Prompt sections, tool schemas, adapters, providers, and listeners are installed through `ctx.effect()` or `ctx.on()` so reload and teardown unwind them predictably.

## Dispatch Modes

Use the mode to understand what a listener can do:

| Mode | Shape |
|---|---|
| `emit` | synchronous notification; listeners observe but do not shape the result |
| `waterfall` | around-middleware; each listener receives `next()` and may wrap, rewrite, or veto |
| `parallel` | awaited fan-out; all listeners run and the dispatcher waits for them |
| `serial` | awaited in registration order; a non-void bail value stops the chain |

The mode is part of the event's public contract. New harness events document it with an `@mode` tag so the generated catalog can check declarations against dispatch sites.

## Cordis Waterfall Semantics

`ctx.waterfall` is around-middleware, not a reducer. A listener receives `(...args, next)`. Call `next()` to delegate, optionally wrapping the result; return without `next()` to short-circuit. Values propagate through `next()`'s return value.

Cooperative listeners usually mutate a shared request or decision object and then delegate. Returning a replacement is a takeover: downstream listeners see the replacement, and earlier mutations on the original object do not carry forward. Use `prepend: true` only when the listener must run before ordinary registrations.

For single-decision events, short-circuiting is the design. A policy listener can return without `next()` when it owns the decision, while a listener that only annotates or observes must delegate.

## Practical Rules

Own vocabulary where the behavior lives: a tool pipeline event belongs to `ctx.tools`, model streaming belongs to `ctx.llm`, and live agent coordination belongs to `ctx.agents`. Prefer events for interception and policy; prefer service methods for direct capability calls.

Every registration should have a disposer, either by returning one from `ctx.effect()` or using a Cordis helper that does it for you. If teardown order matters, keep the related work in one effect so disposal unwinds in the intended sequence.
