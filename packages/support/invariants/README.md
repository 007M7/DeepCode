# dsh-invariants

Runtime event-contract assertions intended for development diagnostics. This pure-listener plugin checks relationships among session events, agent states, scoped dispatches, and model requests; it does not own or change product behavior.

The plugin has no environment guard: it is active wherever it is registered. The default [`dsh-agent-core`](../../core/agent-core/README.md) bundle mounts it unconditionally; a custom composition can omit it when the runtime cost is undesirable. It doubles as executable documentation of the event taxonomy — the assertions *are* the contract.

Session itself owns immutable log storage in every composition: it takes one lossless JSON snapshot of each accepted event, deep-freezes that record, and exposes the log through immutable array snapshots. The invariants plugin checks the cross-record and cross-seam rules that storage immutability cannot express.

Session-log assertions run during Cordis `internal/dispatch`, while `Session.append()` is resolving the `session/event` callback snapshot but before it pushes the candidate into the log. A valid transition is staged by exact event identity and applied to the live trace only when that same committed event reaches the plugin's contained post-commit listener. A later internal dispatch check can therefore veto without advancing either the log or the invariant trace, while ordinary `session/event` observer failures remain observe-only.

## Plugin

A functional plugin — register the module namespace (this is what loading by name in `cordis.yml` does):

```ts
import type { Context } from 'cordis'
import * as Invariants from '@deepseek-ai/dsh-invariants'

declare const ctx: Context

await ctx.plugin(Invariants)
```

`inject`: `['sessions']` — it reads `ctx.sessions.list()` at apply time to rebuild trace state for sessions that already exist, so a hot reload mid-turn does not falsely reject the next event. The oracle listeners are explicitly global so pre-commit staging and post-commit application keep the same audience even if the plugin is mounted under a scoped context; their cleanup still belongs to that mounting fiber. The plugin has no configuration.

## Invariants asserted

Session log (per session):

- **`seq` strictly increases** — the spine of replay equivalence.
- **turns pair and nest** — `turn/start` opens a turn, `turn/end` closes the matching one; no overlapping turns.
- **steps nest in turns** — `step/start` opens a step in the open turn; `step/end` closes the matching step.
- **chunks belong to an open step** — `step/start` precedes its `assistant/chunk`s.
- **a `tool/result` needs a prior `tool/call`** — but NOT the converse: a `tool/call` may have no result (a thrown tool-execution pipeline step ends the turn with no `tool/result`, which is legal).

Agent status (per agent):

- **legal transitions only** — `idle↔running` and `(idle|running)→disposed`. A no-op transition (`setStatus` dedups, so it never fires) and leaving the terminal `disposed` state are violations.

Model requests (on `llm/stream`):

- **a loop-built request is exactly what the log reconstructs** — a frozen request with a live `sessionId` (the loop-built marker; hand-built one-shots like compaction's summarize are unfrozen and skipped) must carry frozen `messages` deep-equal to the derivation over the log prefix strictly before the in-flight step's `step/start` (rebuilt through a FRESH `Session`, so the live cache cannot vouch for itself — and boundary-correct: content logged after `step/start` legitimately belongs to the next request), and every non-content field must equal the fold of the log's `request/header*` events (see [the reconstructability RFC](../../../docs/rfc/implemented/architecture/2026-07-05-reconstructable-requests.md)). Registered with `prepend: true` so a short-circuiting `llm/stream` listener (the replay adapter) cannot silence it; prepend orders it against append-registered listeners only — correctness rests on the seq-bounded rebuild, never listener timing.

On any violation it throws `InvariantError` (`code: 'INVARIANT'`).

## Why runtime assertions remain useful

Session enforces the per-record storage boundary at runtime, where a cast cannot bypass it. Pervasive `DeepReadonly<SessionEvent>` types would add noise across consumers without expressing relationships such as turn/step nesting, subject-correct scoped dispatch, or equality between a request and its log reconstruction. This plugin checks those relationships wherever it is mounted while `dsh-session` keeps history immutable in every composition. See [source-owned session immutability and dev-mode invariants](../../../docs/rfc/implemented/architecture/2026-06-11-dev-invariants-over-deep-readonly.md).

## Seeded sessions

A seeded or forked session arrives with events already in its log because construction does not emit `session/event` for each seed record. `Session` validates, snapshots, and freezes every seed record before accepting it; on `session/created`, this plugin replays the accepted log only to rebuild and check its relational trace state.

## Model Experience

None, as this observer only validates events and frozen requests and never rewrites prompts, schemas, messages, or streams.

## Known Limitations and Deferred Work

- **The request-reconstructability assertion covers loop-built requests only** — hand-built one-shots (e.g. compaction's summarize call) carry no live `sessionId` marker and are skipped.
- **Merge-extended event families get no family-specific assertions** — `compact/*` lock pairing and `hook/*` invoked/result pairing are not checked here; only the core turn/step/chunk/tool-result contract is.
