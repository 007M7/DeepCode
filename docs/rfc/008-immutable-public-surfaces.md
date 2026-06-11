# RFC 008: Deep-readonly public surfaces

Status: proposed

## Problem

The session log is append-only by contract, but `session.events` returns
`readonly SessionEvent[]` whose *elements* are mutable: a plugin can reach in
and rewrite history (`events[0].data.content.push(...)`), silently breaking
replay equivalence and the derived-history guarantee. The same applies to
derived messages and prompt assemblies passed through waterfalls — mutation
is sometimes the intended idiom (waterfall middleware mutates the request)
and sometimes corruption (mutating a *logged* event), and the types don't
distinguish.

## Proposal

Make immutability part of the type where mutation is corruption:

- `SessionEvent` data becomes `DeepReadonly` on the way OUT of a session
  (`events`, `session/event` listeners); `append()` keeps taking plain
  mutable input. A `DeepReadonly<T>` utility type lands in dsh-llm next to
  the brand/never helpers.
- `deriveMessages()` returns deep-readonly messages; the loop clones before
  handing a mutable request to the `agent/request` waterfall (mutation there
  is sanctioned — the clone makes the boundary explicit and cheap, once per
  step).
- `PromptAssembly` stays mutable through its waterfall (sanctioned) but the
  registry's internal section list is cloned per assembly (already true).
- Optionally, dev-mode `Object.freeze` of event data behind the RFC 005
  invariants flag, so sanctioned-mutation violations throw in tests rather
  than corrupting silently.

## Plan

Introduce `DeepReadonly`, flip the session read paths, fix resulting
compile errors in consumers (expected: a handful in tests), add the
freeze-in-dev option alongside RFC 005's invariants plugin.

## Risks

`DeepReadonly` types can produce noisy errors at waterfall boundaries where
mutation IS the API — keep the mutable/readonly boundary exactly at "logged
vs in-flight" and document it in the session README.
