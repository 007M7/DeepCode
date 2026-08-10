# Agent Note: Remote event delivery (ctx.remote.$on)

Status: proposed

English | [中文](2026-08-10-remote-event-delivery.zh.md)

## Problem

[TypeRT Gateway targeted method calls](2026-08-02-typert-remote-method-calls.md) cover only the request/response shape and deliberately leave Session event streams and stateful interactions to separate designs. Every **one-way Host-to-consumer push** therefore still rides the legacy API Proxy.

The Host owns a family of pure invalidation events — "a registry changed, refetch it" — whose payloads are already JSON and whose emission never binds an AgentScope: `commands/change`, `credentials/updated`, `settings/document-updated`. Reaching one UI subscriber takes four hops: the Host cordis event, a hand-written `HostFrame` variant plus its zod branch in apiproxy, a hand-written bridge in client/runtime that re-emits it as a Client cordis event, and finally the consumer's `ctx.on(...)`. Adding one such event edits five places (frame union, zod union, host-stream listener, client bridge, a duplicated Client-side `Events` declaration), and not one of them states a new fact: the name, the payload type, and the emission point were all declared by the owner package's cordis `Events` merge.

That duplicated declaration is also **lossy**: the Client side restates it as `settings/changed(ns: string)`, flattening a branded type into bare `string` — the opposite of the Remote method contract, where a consumer type points at the business package's one canonical symbol.

## Proposal

Add one one-way subscription verb to the consumer Remote surface, `ctx.remote.$on(event, listener)`, driven by an allowlist and forwarding verbatim:

- `packages/api/remotes/src/types.ts` holds the allowlist of forwardable Host events, and it is the single control point over what a consumer may subscribe to. That file is listed in the `files` of **both** of this package's faces, so the Host forwarding loop and the consumer key surface read one declaration.
- The wire event name **is** the Host cordis event name (`settings/document-updated`) with no `host/` prefix, and the payload **is** the Host argument list, element for element, with no projection, redaction, or renaming.
- The carrier reuses the existing host stream: `HostFrame` gains one wrapper variant, `host/remote-event`. No new downlink.
- Event **signatures** get no second table. Each owner package moves its cordis `Events` declaration into its client-safe, type-only `./types` export, so both faces read the same declaration and `$on`'s listener type is `Events[Event]` itself. "Verbatim" then holds by construction rather than by proof.
- Only cordis's *type shape* is borrowed, not its event system: delivery semantics, the subscription registry, and failure containment belong to TypeRT.

When an `Events` entry's signature reaches a Host-only symbol (a Service, `Agent`, a Context), the answer is to **split the code until the entry lands cleanly in `./types`** — never a declaration half-left in `index.ts`, and never a structurally equivalent shadow type in `./types`. None of the three packages needed that here: their entries reach only `SettingsNamespace`, `SettingsUpdateSource`, and `CredentialRef`, all pure types.

This change migrates the three **pure passthrough** events and deletes their `HostFrame` variants. Everything with derivation stays untouched: `host/models-changed` (a fan-in of `llm/adapters-updated` with provider/agent-default namespace filtering), `host/workspace-changed`/`-removed`/`host/archived-sessions-changed` (view derivation plus per-connection dedup state), and `host/session-added`/`-removed`/`host/session-status`/`host/agent-error` (live-object projection or frame-time derived fields).

`skills/change`, `tools/change`, and `system-prompt/change` have the same shape but **no consumer today**; under "require a current owner and need" they stay out of the allowlist and are recorded here only as the extension seat.

### Consumer contract (dsh-type-meta)

type-meta gains one **shape predicate**, one **selection seat**, and **one** member on `TypeRTClientRemote`. No runtime code:

```ts
/** Cordis events shaped for one-way remote delivery: no Scope binding, void return. */
export type TypeRTForwardableEvent = {
  [Event in keyof Events]: unknown extends ThisParameterType<Events[Event]>
    ? ReturnType<Events[Event]> extends void ? Event : never
    : never
}[keyof Events]

/** The Host assembly's forwarding selection; api/remotes' allowlist fills it, no other package does. */
export interface TypeRTRemoteEventSelection {}

/** `$on`'s legal keys: selected, and present in the current compilation face. */
export type TypeRTRemoteEvent = Extract<keyof Events, keyof TypeRTRemoteEventSelection>
```

```ts
/** Subscribe to one forwarded Host event; the returned disposer belongs to the calling fiber. */
$on<Event extends TypeRTRemoteEvent>(event: Event, listener: Events[Event]): () => void
```

`Events` resolves per program: the full Host vocabulary in the Host program, whatever the Client face can see in the Client program. The same predicate therefore holds on both sides without dragging Host declarations into the Client.

**The consumer surface has `$on` and no `$dispatch`.** The port that hands a decoded frame to the subscription table stays out of the developer-visible contract, and it cannot be a module-level function reaching across Client plugins: the client bundle purity gate (`packages/client/tsdown.client.ts`) admits value imports only from `CLIENT_EXTERNALS`, the `INLINE_SAFE` wire layer, and generated `/remote` contributions — and inlining around it would copy `ClientRemoteService` into the runtime bundle, making `instanceof` permanently false.

The port is therefore **one internal Client cordis event**, declared in `dsh-type-meta` (a single-face package both sides already depend on, so no new dependency):

```ts
'remote/host-event'(event: string, args: readonly unknown[]): void
```

client/runtime — the owner of the host frame sink — emits it; `ClientRemoteService` is the only subscriber and turns it into `$on` callbacks through a private `dispatch`. This is the repository's existing cross-plugin plumbing shape: `connection/reset` is declared and emitted by runtime, subscribed by `ui-command`, and pinned by `runtime/tests/wire-events.spec.ts`. The `event` parameter is `string`, not `TypeRTRemoteEvent`: this is a wire boundary, and a name nobody subscribed to is dropped silently.

Delivery shares no implementation with the cordis event system: one-way only, no waterfall/bail/parallel/serial modes and no `@mode` concept (`ReturnType extends void` is the static expression of that rule), no `this` binding, no `EventOptions`, `prepend`, or priority. Listeners run in registration order, and one that throws is contained and logged — it must never take down the frame pump (the same posture `ConnectionController` already applies to its sinks).

### The allowlist: one file both faces read

`packages/api/remotes/src/types.ts` is listed in the `files` of both `tsconfig.host.json` and `tsconfig.client.json`, and is the allowlist's single home:

```ts
export const API_REMOTE_FORWARDED_EVENTS = [
  'commands/change',
  'credentials/updated',
  'settings/document-updated',
] as const

export type ApiRemoteForwardedEvent = typeof API_REMOTE_FORWARDED_EVENTS[number]

declare module '@deepseek-ai/dsh-type-meta' {
  interface TypeRTRemoteEventSelection extends Record<ApiRemoteForwardedEvent, true> {}
}
```

Forwarding one more event is therefore **one line in that array**: the type projection, `$on`'s key surface, and the Host forwarding loop all derive from it. `ctx.remote.$on('slots/changed', …)` (a Client-local event) and `$on('skills/change', …)` (declared but unselected) are both **compile errors**.

The Host face adds one shape assertion, binding the Host event vocabulary to that same array:

```ts
API_REMOTE_FORWARDED_EVENTS satisfies readonly TypeRTForwardableEvent[]
```

It is an expression statement rather than a named constant, which `noUnusedLocals` would reject (the underscore prefix exempts parameters only). It enforces three things: the **name is real** (the predicate is keyed on `keyof Events`), the event **binds no Scope** (`goal/changed` and kin have a `ThisParameterType` other than `unknown` and drop out — the static expression of "no AgentScope dependency"), and the event is **one-way** (a non-`void` return, i.e. a waterfall/bail shape, drops out).

**"Verbatim" is proved nowhere because it holds by construction**: `$on`'s listener type comes from the one cordis `Events` declaration in the owner package's `./types`, and Host forwarding reads that same declaration. There is no second declaration that could drift.

JSON-safety is a runtime concern: before forwarding, apiproxy validates each argument with `dsh-session`'s `isJsonValue` and **throws loudly** when one fails, because that is an allowlist composition mistake rather than untrusted input.

### Wire contract (apiproxy)

```ts
| { type: 'host/remote-event'; event: string; args: JsonValue[] }
```

The zod branch keeps `args: z.array(z.unknown())`: the frame arrives from `JSON.parse`, so every element is already a JSON value, and the structural contract belongs to the owner package's `Events` declaration — the same posture the existing `session/projection` frame takes with its `value`.

`events.host()` subscribes by allowlist when the stream opens (each stream owns its disposers, so no broadcast set is needed). **The registration position is part of the contract**: this block must sit *before* the `settings/document-updated` listener. Cordis fires in registration order, and `host/models-changed` is an invalidation frame *derived* from that same Host event; placing the forwarded frame after the derived one flips the relative order of two frames from one emit compared with the previous behavior (two config cases observe it).

Cordis keys `on` by literal event name, so subscribing from a runtime list erases the handler type once. That is the only type assertion this change introduces; its safety rests on the allowlist predicate and the `isJsonValue` check.

`api/events.ts` is a wire contract file the browser side also compiles, so every type it references must come from an owner package's **client-safe, type-only subpath**, never the package root. Evidence: importing one type from `@deepseek-ai/dsh-session` root drags the root's `declare module 'cordis' { interface Context { sessions: SessionStore } }` into the Client compilation face and overrides the Client's `ctx.sessions: ISessions`, producing 18 errors in the unrelated `ui-slash` and `ui-conversation`. `JsonValue` therefore needs a re-export from `dsh-session/src/types.ts`.

### The apps/web browser e2e belong to the Host face

The `apps/web/tests/**` e2e type-check in the root **`tsconfig.host.json`**: they boot a real harness in-process and read `ctx.apiProxy`, the Host `SessionStore`'s `get`/`create`/`flush`, and `ctx.sessionProjectionCache`. **Driving a browser at runtime does not make a file part of the Client program** — moving them into the Client aggregate immediately produces 21 errors, because one program cannot hold both faces' merges for the same Context key.

That yields a discipline this design depends on: **when those tests import a value or a type from a Client package, they pull that package's whole project — and every project it references — into the Host build graph**. Four consumers (`ui-settings-general`, `ui-models`, `ui-permission`, `ui-command`) reference `api/remotes`' Client face, and that face cannot compile until Host tsdown has generated `@deepseek-ai/dsh-goal/remote`. The result is a build-order deadlock: Host tsc needs the Client face, which needs the generated artifact, which Host tsdown produces after Host tsc.

This change therefore **mirrors** the few Client-owned symbols on the test side (`scaffold.ts` exports the mirrored welcome-notice constants; the two chat e2e keep importing `dsh-client-runtime/client` because the `runtime` project is already in the Host graph), which lets those four consumers leave the Host graph. The 15 Client project references in `apps/cli/tsconfig.json` then lose their owner-map role and are deleted as a group. Each mirrored value matches its source verbatim; a drift shows up as a missed selector or an unsuppressed notice, both loud failures.

### Change inventory

| Location | Change |
|---|---|
| `dsh-type-meta` | `src/types.ts` gains `TypeRTForwardableEvent`, `TypeRTRemoteEventSelection`, `TypeRTRemoteEvent`, and the `'remote/host-event'` declaration; `TypeRTClientRemote` gains `$on`. Types only, no runtime |
| `api/gateway` Client half | `ClientRemoteService` implements `$on` (subscription table, `ctx.effect` ownership for the calling fiber, registration-order delivery with listener failures contained) and subscribes to `'remote/host-event'`; `dispatch` stays private |
| `api/remotes` | New `src/types.ts` (allowlist, type projection, selection seat) listed in both faces' `files`; a `./types` export with `lib/types/**/*.js` added to `files`; the Host face adds the shape assertion and `import type {}` for the three owner `./types`; the Client half re-exports those three plus `@deepseek-ai/dsh-api-gateway/client`; `./invariant` asserts the runtime relation for allowlisted events (`thisArg === null` and `mode === 'emit'`) |
| Root `tsconfig.base.json` | Three `paths` entries (`dsh-settings/types`, `dsh-credentials/types`, `dsh-api-remotes/types`), all pointing at the **source** plane |
| `dsh-commands` / `dsh-settings` / `dsh-credentials` | The `interface Events` sub-block moves into each package's client-safe `./types` (settings and credentials create that export, moving the brands and pure types with it; `index` keeps re-exporting them and keeps the constructors; `files` gains `lib/types/**/*.js`) |
| `host/apiproxy` | `HostFrame` gains `host/remote-event` and loses `host/commands-changed`/`-settings-changed`/`-credentials-changed` with their zod branches; `events.host()` subscribes by allowlist ahead of the `settings/document-updated` listener and validates through `assertJsonArgs`; the `settings/document-updated` listener stays to keep feeding `host/models-changed` |
| `dsh-session` | `src/types.ts` re-exports `JsonValue` so wire contract files can use the client-safe subpath |
| `client/runtime` | The bridge's three `ctx.emit` branches collapse into `ctx.emit('remote/host-event', frame.event, frame.args)`; the `Events` merge drops `commands/changed`, `settings/changed`, and `credentials/changed` (`models/changed` stays) |
| Five consumers | ui-command / ui-models / ui-settings-general / ui-permission / ui-agent-preset subscribe through `ctx.remote.$on(...)`, following `ui-goal`'s precedent for the type-only facade import and the `'remote'` injection |
| `client/connection` | The fixture's `emitHost` produces `host/remote-event` |
| `apps/web/tests` + `apps/cli` | Client symbols mirrored on the test side (see above); `apps/cli/tsconfig.json` drops its 15 Client project references |

## Alternatives considered

**Open a general downlink channel for Remote events** (the push counterpart of `ctx.connection.rpc`, a third WebSocket). This best matches "Connection owns the carrier, the Gateway never touches transport", but it means a new stream in the Host downlink, `WebApiClient`, `ConnectionController`, the fixture, and the web e2e — a cost out of proportion to this change. Reusing the host stream costs a temporary tenancy inside a legacy frame union; when that stream moves, the wrapper moves with it and the consumer contract does not change.

**Declare a separate `TypeRTRemoteEventMap` in type-meta and let owner packages merge into it.** The consumer key set would equal exactly "events declared remotely deliverable", but every signature would be written a second time outside cordis `Events`, requiring a bidirectional `extends` proof to stop the two from drifting, plus a new type-meta dependency for three owner packages. Sharing the one `Events` declaration makes that equivalence structural, so the table is not created.

**Have the typert generator project Host `Events` declarations** (codec, `.d.ts`, declaration map, like `/remote`). The generator already analyzes Host events, but it cannot see projection or redaction intent, and it would change the generator and the build surface. Verbatim forwarding needs no projection.

**Give forwardable events a payload projection function** (a `{ name, project, zod }` forwarding table). This would cover `models-changed`'s fan-in and workspace view derivation in one step, at the cost of hand-aligning projection logic with payload types — the central table the method side just removed.

**Move the apps/web browser e2e into the Client aggregate.** "Client tests belong to the Client face" looks right and fails immediately with 21 errors: those tests use Host services, and in the Client program `ctx.sessions` is `ISessions`.

**Split `directory-picker-browse`/`-native` into Host and Client faces** so no Client package reaches the Host graph. The direction is right — they are genuinely unsplit dual-half packages — but it is a separate concern from this capability seam and lands in another owner's packages; recorded as its own follow-up.

## Acceptance criteria

- Emitting the three Host events puts one `host/remote-event` frame each on the real host stream, with `event` the Host name and `args` equal element for element (a real composition test).
- The allowlist rejects three candidate classes at the type level: a name that is not an event, a Scope-bound event (`goal/changed`), and an event whose return is not `void`.
- `$on`'s key surface equals the allowlist: `$on('slots/changed', …)` and `$on('skills/change', …)` must both fail to compile.
- `TypeRTClientRemote` has **no** `$dispatch`: the developer-visible contract is `$on` plus the existing `$mount` and generated namespaces.
- A non-JSON-safe argument makes `assertJsonArgs` throw rather than degrade silently; that function is unit-tested directly instead of driving a malformed emit through the event bus.
- `ctx.remote.$on`'s disposer belongs to the calling fiber: disposing the fiber removes the subscription. One throwing listener affects neither its siblings nor later frames.
- For one emit, the forwarded frame and the invalidation frame derived from the same Host event keep the pre-change relative order.
- On the consumer side, `$on('settings/document-updated', …)` resolves `ns` as `SettingsNamespace` — the brand survives the wire.
- The three `HostFrame` variants, the three Client-side `Events` declarations, and the three bridge branches disappear in the same change; `host/models-changed` behavior is unchanged.
- `pnpm run build` passes.

## Risks

- **Tenancy inside a legacy frame union.** The new contract temporarily lives in apiproxy's `HostFrame`, so a reader may assume apiproxy owns Remote events. The frame's JSDoc names `api-remotes` as the allowlist owner, and apiproxy's README records the tenancy under known limitations.
- **The shared file breaks api/remotes' face-disjointness contract.** `src/types.ts` belongs to both projects, so each emits an identical declaration into the shared `lib/types`. Content is byte-identical and the `.tsbuildinfo` files stay separate, so this is harmless in practice — but the README's build-boundary section must state the exception and its cause (the `paths` entry points at source).
- **Any Client plugin can `ctx.emit('remote/host-event', …)`** and synthesize a Host event. This is the same exposure `connection/reset` already has for a fabricated reconnect; the Client is one trust domain. Tests pin the event-to-`$on` conversion and do not pretend the port authenticates its source.
- **The allowlist's shape assertion is currently commented out** in `packages/api/remotes/src/index.ts`, together with the allowlist import and the three owner `./types` type-only imports it needs. The three static guarantees described above are therefore inactive right now: adding a Scope-bound or misspelled name would not fail to compile. Restoring it does not change the build graph (those four consumers already left the Host graph) and is required before the pull request.
- **Mirrored test values can drift.** Nothing mechanically checks the Client constants mirrored in `apps/web/tests` against their source; the safety net is only that a drift misses a selector. A grep-level gate forbidding `@deepseek-ai/dsh-client-*` imports under `apps/web/tests` would close this and is not part of this change.
- **The dynamic subscription erases a handler type.** Subscribing by allowlist requires one erasure at `ctx.on(name, …)`; if the predicate is later relaxed, that assertion loses its static backing.
- **Capabilities given up.** No projected or redacted payloads, no Scope-bound events (`agentCtx.remote.$on`), and no replay on reconnect — these are pure invalidation signals, and the existing `connection/reset` already covers refetching after a reconnect. The mux stream's session events, answerable frames, and snapshot baselines stay out of scope.
- **Client packages remain in the Host graph.** Twelve projects (`connection`, `runtime`, `ui-slots`, and kin) still reach it through the unsplit `directory-picker-browse`/`-native` pair and `api/gateway → client/connection`. They compile and no longer implicate api/remotes' Client face, so they do not block this change; the root fix is the follow-up above.
