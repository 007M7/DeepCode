# @deepseek-ai/dsh-session-projection

Session-projection seam. It owns `ctx.sessionProjections`, the registry through which a domain host plugin serves the whole current value of its log-derived per-session state, and through which a carrier (the api-proxy history tail page today; TUI/ACP/headless consumers later) reads every registered value in one synchronous, seq-consistent cut. Design authority: the [session-projection RFC](../../../.agents/notes/proposed/architecture/2026-07-27-session-projection-and-command-log.md).

## Service: `SessionProjectionRegistry` (ctx key: `sessionProjections`)

### Public API

- `ctx.sessionProjections.register(provider): () => void` Register one domain's provider. Duplicate keys throw; the registration is an effect on the calling fiber, so an unloaded domain plugin's key disappears from subsequent walks (clients read that as capability absence).
- `ctx.sessionProjections.entries(): AnyProjectionProvider[]` Snapshot the registered providers in registration order — the carrier walk surface.

### Key Types

- `SessionProjectionMap` — the single merge-extensible type table for the whole chain (host provider, wire block, client cell, React hook). Values are wire-JSON whole values; rendering belongs to the slot system, never this layer.
- `ProjectionProvider<K>` — `{ key, schema, get(agent) }`. `schema` validates the payload before it leaves the host; `get` returns the current whole value and MUST be synchronous.

## Contract

- **Whole-value rule (load-bearing).** A state-carrying log event MUST carry the complete post-change state, never a delta, so the client fold is last-wins by seq. A future domain logging deltas breaks last-wins silently — do not.
- **Synchronous `get`.** Carriers read `session.seq` and every provider value with no await between them; that is what makes `asOfSeq` one consistent cut across all keys. An accidentally-async `get` returns a Promise, which fails the carrier-side `schema.parse` loudly.
- **Full-log view.** `get` runs against the host's full in-memory log (`agent.session.events`); pagination exists only in the history slice served to clients. A last-wins domain may backscan (first hit from the tail terminates); an expensive fold keeps an incremental cache keyed by observed seq.
- **Optional seam.** Domain plugins register under `ctx.inject(['sessionProjections'], …)` so headless assemblies without the registry stay unaffected; carriers use `ctx.get('sessionProjections')` and omit the block entirely when the registry is absent.

## Role

This is the interface package of the capability-seam split: domain host plugins (e.g. `dsh-tool-todo`) contribute providers, carriers (`dsh-host-apiproxy`) consume the walk surface, and neither knows the other.

## Model Experience

None, as the registry only serves client-facing read models of already-logged session state and touches no prompt, message, schema, stream, or tool result.

#### KV Cache effect

None; projections never assemble or send provider requests.

## Known Limitations and Deferred Work

- **Every tail page carries every registered key** — there is no per-key opt-out or lazy-key request shape yet; acceptable while values are UI-scale whole states (a todo list, a goal snapshot), revisit if a domain's value grows large.
- **Synchronous-`get` discipline is only partially mechanical** — the carrier's `schema.parse` rejects a returned Promise, but a provider that blocks or reads torn non-session state is a review concern; the invariant companion documents why no runtime check exists.
