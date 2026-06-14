# ADR 0012: Dev-mode invariants over compile-time deep-readonly

Status: accepted (2026-06-13)

## Context

The session log is append-only by contract, but the types don't enforce it: `session.events` returns `readonly SessionEvent[]` whose *elements* are mutable, and `deriveMessages()` handed the logged `content` arrays/blocks out by reference. The loop then passes those derived messages into the `agent/request` waterfall and on to adapters, where mutating the request is sanctioned — so a request middleware could reach back and rewrite history, silently breaking replay equivalence and the derived-history guarantee. Separately, the event taxonomy (turn/step nesting, seq monotonicity, tool-call/result pairing, legal status transitions) was asserted only where individual tests happened to look.

Two ways to defend the log: make immutability part of the type (`DeepReadonly<SessionEvent>` on the way out), or catch corruption at runtime in dev. The RFC (005) proposed the runtime route; RFC 008 proposed the type route.

## Decision

Reject the pervasive `DeepReadonly<T>` type flip. Instead:

1. **Always-on:** `deriveMessages()` deep-clones the content it emits (one `structuredClone` per derived message). In-flight mutation of a request can no longer reach the log — this is the real fix, and it costs nothing meaningful next to a model call.
2. **Dev-mode:** a new `dsh-invariants` plugin (pure listeners, off in production, on in tests and demos) asserts the event contract and `Object.freeze`s logged event data so any *other* code that mutates a logged event throws instead of corrupting silently. Seeded sessions are frozen and checked on `session/created` (the constructor copies the seed without emitting `session/event`).

The invariants encode the *real* contract, not an idealized one: a `tool/call` may have no `tool/result` (a thrown `tools/execute` waterfall ends the step), and both `idle→disposed` and `running→disposed` are legal.

`DeepReadonly` was rejected because it is compile-time only (a plugin casts straight through it), high type-noise across every log/message consumer and adapter, and would force readonly types through code where mutation is the sanctioned API. The clone draws the mutable/immutable boundary exactly at "logged vs in-flight" without any of that noise.

## Consequences

- History corruption is caught loudly in tests and demos, at zero production cost and zero type noise. The trade-off is that the guarantee is dynamic (a dev-mode tripwire) rather than static.
- The invariants plugin doubles as executable documentation of the event taxonomy — the assertions are the contract.
- `Session.events` keeps its `readonly SessionEvent[]` type; no consumer churn.
- This folds in RFC 008 — there is no separate deep-readonly ADR; this records the decision to *not* pursue that approach. `InvariantError` is a plain `Error` with a `code` for now; a later taxonomy change can promote it.
