# dsh-invariants

Dev-mode event-contract invariants and session-log freeze. A pure-listener plugin (everything is a plugin) that asserts the harness event contract at runtime and, optionally, freezes logged session-event data so any code that mutates history throws instead of corrupting silently.

**Off in production.** Enable it in tests and the demos, where a contract violation should fail loudly. It costs nothing when not registered, and doubles as executable documentation of the event taxonomy — the assertions *are* the contract.

## Plugin

A functional plugin — register the module namespace (this is what loading by name in `cordis.yml` does):

```ts
import type { Context } from 'cordis'
import * as Invariants from '@deepseek-ai/dsh-invariants'

declare const ctx: Context

await ctx.plugin(Invariants)                     // freeze on (default)
await ctx.plugin(Invariants, { freeze: false })  // assert contract, don't freeze
```

`inject`: `['sessions']` — it reads `ctx.sessions.list()` at apply time to rebuild trace state for sessions that already exist (so a hot reload mid-turn doesn't falsely reject the next event). It listens on `session/created`, `session/event`, and `agent/status`.

### Config

| Key | Default | Meaning |
|---|---|---|
| `freeze` | `true` | Deep-freeze each logged event's data so mutating a logged event throws. Set `false` to assert the contract without freezing. |

## Invariants asserted

Session log (per session):

- **`seq` strictly increases** — the spine of replay equivalence.
- **turns pair and nest** — `turn/start` opens a turn, `turn/end` closes the matching one; no overlapping turns.
- **steps nest in turns** — `step/start` opens a step in the open turn; `step/end` closes the matching step.
- **chunks belong to an open step** — `step/start` precedes its `assistant/chunk`s.
- **a `tool/result` needs a prior `tool/call`** — but NOT the converse: a `tool/call` may have no result (a thrown tool-execution pipeline step ends the turn with no `tool/result`, which is legal).

Agent status (per agent):

- **legal transitions only** — `idle↔running` and `(idle|running)→disposed`. A no-op transition (`setStatus` dedups, so it never fires) and leaving the terminal `disposed` state are violations.

On any violation it throws `InvariantError` (`code: 'INVARIANT'`).

## Why runtime, not deep-readonly types

A `DeepReadonly<SessionEvent>` is high type-noise across every log consumer, and a plugin can cast straight through it. A dev-mode freeze plus these assertions catch real corruption at zero production cost and zero type noise. The always-on half of that defense — cloning derived messages so request/adapter mutation can't reach back into the log — lives in `dsh-session`'s `deriveMessages`. This package is the dev-mode tripwire. See [dev-mode invariants](../../../docs/rfc/implemented/architecture/2026-06-11-dev-invariants-over-deep-readonly.md).

## Seeded sessions

A seeded/forked session arrives with events already in its log (the `Session` constructor copies the seed without emitting `session/event`). On `session/created` the plugin replays the existing log through the checker and freezes those entries, so seeded history is held to the same contract.
