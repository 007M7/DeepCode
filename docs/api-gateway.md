# API Gateway

English | [中文](api-gateway.zh.md)

This is the current-state reference for the TypeRT API Gateway. It describes how business services declare unary Remote methods, how the build generates Host and Client contracts, and how calls reuse the Connection RPC and `/api` route. Session events, incremental data, and other streaming protocols are outside this document's scope; they may use the same Connection but do not use Remote method descriptors.

## Programming model

Business services use `@Remote` or `@RemoteContext` to select the methods exposed to the Client. Unmarked methods do not enter the generated Client types or runtime contributions and cannot be called through `ctx.api`.

`@Remote` denotes calling a Cordis service registered on the root Host Context. Complex Host objects cannot cross the wire directly; the business package must declare their association with a wire identity through `TypeRTLookupMap` and register a default resolution provider with `ctx.typert.lookups` at runtime. For example, an `Agent` parameter named `agent` in the Host signature produces an `agentId` wire field, and the Gateway resolves that id to a Host object before invoking the business method. Host composition can use `ctx.typert.lookups.configure()` to override the resolution policy for a lookup key without changing the parameter name, wire field, or canonical type symbol owned by the business package.

`@RemoteContext(key)` first resolves an identity to a scoped Context through `ctx.typert.contexts`, then obtains the service from that Context and invokes the method. It applies when the method itself depends on scoped composition and does not need to receive objects such as `Agent` explicitly.

Services normally extend `GatewayService` so the constructor explicitly binds the Cordis service key and default Remote namespace. A service that already has another base class can instead declare `readonly typertGateway = bindTypeRTGateway(this, serviceKey)`; both forms leave an inspectable public binding and do not depend on the compiler injecting a symbol into the constructor.

```ts
import type { Agent } from '@deepseek-ai/dsh-agent'
import { GatewayService, Remote, RemoteContext } from '@deepseek-ai/dsh-type-meta'
import type { Context } from 'cordis'

export interface CreateGoalRequest {
  objective: string
}

export interface CreateGoalResult {
  accepted: boolean
}

export class GoalService extends GatewayService {
  constructor(ctx: Context) {
    super(ctx, 'goals')
  }

  @Remote('create')
  createForClient(
    agent: Agent,
    request: CreateGoalRequest,
    signal: AbortSignal,
  ): CreateGoalResult {
    signal.throwIfAborted()
    return this.create(agent, request)
  }

  @RemoteContext('agent', 'current')
  currentForClient(): CreateGoalResult {
    return { accepted: true }
  }

  private create(_agent: Agent, request: CreateGoalRequest): CreateGoalResult {
    return { accepted: request.objective.length > 0 }
  }
}
```

Remote methods may return a value synchronously or return a Promise. For cooperative cancellation, the final parameter in the Host signature must be `signal: AbortSignal` using the global type; it is recorded in the descriptor instead of entering `args`, while the generated Client method accepts an optional final `AbortSignal`.

The Client uses concrete functions on ordinary objects, not a JavaScript Proxy. Direct Remotes appear under `ctx.api.<namespace>`; when an `@Remote` method has exactly one lookup parameter and a same-named `TypeRTContextMap` uses the same wire identity, the generator also projects the method without that identity parameter onto the corresponding scoped Context. `@RemoteContext` generates only the scoped invocation interface.

```ts
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AgentContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { Context } from 'cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'

declare const ctx: Context
declare const agentCtx: AgentContext
declare const agentId: SessionId

await ctx.api.goals.create(agentId, { objective: 'ship it' })
await agentCtx.goals.create({ objective: 'ship it' })
```

Client applications assemble only `@deepseek-ai/dsh-api-remotes`. That package imports the `/remote` subpaths of selected business packages as runtime values, mounts their contributions on `ctx.api`, and re-exports the declaration merges from the same files. Adding a Host Remote package is an explicit choice by the Client composition owner; business components do not need to load the TypeRT Gateway or the business package's Remote JS separately.

A future TUI can assemble the same React-independent `api-remotes` and `ctx.api` contract, so the Host methods visible to it are likewise limited to the Remote methods selected at generation time. This document does not define or implement the TUI composition.

## Component responsibilities

| Location | Package or entry | Responsibility |
|---|---|---|
| Shared | `@deepseek-ai/dsh-type-meta` | Declares decorators, Gateway bindings, merge-extensible protocol maps, invocation descriptors, and provider types; starts no TypeScript analysis and registers no Cordis services |
| Build | `@deepseek-ai/dsh-typert-generator` | Strictly analyzes Remote signatures, the type graph, lookups, Contexts, and source locations from the Host `ts.Program`, then generates Host and Host-for-Client artifacts |
| Host | `@deepseek-ai/dsh-typert-registry` and Loader | Places generated Host descriptors, schemas, and business-package registrations in `ctx.typert`, and holds lookup and Context providers |
| Host | `@deepseek-ai/dsh-api-remotes` | Owns the application Agent/Session identity policy and configures the corresponding TypeRT lookups |
| Host | `@deepseek-ai/dsh-api-gateway` | Provides `ctx.typertGateway`, claims Remote endpoints, resolves objects or Contexts, invokes live Cordis services, and validates boundaries |
| Client | `@deepseek-ai/dsh-api-gateway/client` | Provides `ctx.api`, mounts generated descriptors as concrete methods, and initiates, validates, and cancels calls through the Connection |
| Client | `@deepseek-ai/dsh-api-remotes/client` | Explicitly selects and mounts the `/remote` contributions allowed by the application and brings the corresponding declaration merges into business code |
| Both | `@deepseek-ai/dsh-client-connection` | Provides the RPC carrier, request correlation, trust boundary, cancellation, response envelope, and current `/api` HTTP bridge |

The API Gateway package owns the Host dispatcher and Client API as peer entries, but the two builds never enter the same `ts.Program`. The Host entry does not import the Client Cordis `Context` merge, and the Client entry does not import the Host Gateway service.

## Strict generation pipeline

The root build orders `build:lib:host`, `build:lib:client`, and `build:web`. The Host lib build first runs `build:lib:contracts`: it compiles the TypeRT generator, then starts a Host `ts.Program` through `tsdown.typert-host.config.ts` with `tsconfig.host.json` as its seed. The generator does not put the Host and Client aggregates in the same program, so it does not trigger conflicts between the two Cordis `Context` declaration merges.

Each contributing business package writes generated files to its own `lib/` directory, not to its source directory:

| File | Consumer | Contents |
|---|---|---|
| `typert.host.js` | Host Loader | Runtime reflection for the Host face, strict invocation descriptors, and schema registration values |
| `typert.host.d.ts` | Host type system | Generated declarations for the Host face |
| `typert.remote-client.js` | `api-remotes` | A mountable `TypeRTRemoteContribution` containing strict descriptors and runtime codecs |
| `typert.remote-client.d.ts` | Client type system | Declaration merges for `TypeRTRemoteNamespaceMap` and `TypeRTRemoteContextMap`, plus Client-safe type references |
| `typert.remote-client.d.ts.map` | Editor | Maps generated method properties back to Remote method declarations in the Host package |

Business packages expose the Host Loader entry through `./typert` and the Host-for-Client entry through `./remote`. The generator also validates these package exports and published-file lists; it generates artifacts only for explicit contribution packages that provide the corresponding entry.

Parameter names in Remote Client declarations come from wire fields, while parameter and return types reference Client-safe types exported by the original business package. The declaration map resolves the generated property behind `ctx.api.goals.create` back to the Host source method marked with `@Remote`, so editors that support declaration maps can navigate from a Client call to the real implementation instead of stopping at the generated `.d.ts`.

Strict analysis requires a Remote to be a public, non-static instance method with a concrete implementation. The method cannot be generic; parameters must be required, named simple identifiers and cannot use destructuring, default values, rest parameters, or optional parameters. TypeRT generates strict schemas for ordinary JSON-representable types; complex objects such as workspace classes must have a unique `TypeRTLookupMap` declaration. Lookup and Context packages are responsible for both static declaration merges and runtime provider registration; if either side is missing, the build or earliest resolvable runtime boundary fails.

## Runtime invocation

Remote and API Proxy currently share the Connection's `/api` route; there is no separate `/api2` server or second Connection. The Client API calls `connection.rpc.call('/api', '<namespace>/<method>', { args }, signal)`; the current HTTP carrier maps this to `POST /api/<namespace>/<method>`, with a payload containing only a named `args` object.

The Connection performs the unified trust check for `/api` before the HTTP bridge, then dispatches inside the shared FetchHandler in interceptor order. The TypeRT Gateway claims only two-segment endpoints that have a strict descriptor or active SRC marker; unclaimed requests fall back to the existing API Proxy. The Connection owns transport, RPC ids, response envelopes, and request cancellation, while the Gateway owns only the Remote data protocol and business dispatch. Replacing the Connection carrier in the future does not require changes to Remote descriptors or the Client programming interface.

For every call, the Gateway resolves the descriptor and live service from the current registries instead of caching business objects. It requires the fields in `args` to match the descriptor exactly, validates wire values with codecs, resolves objects or receivers through registered lookup or Context providers, invokes the service method targeted by the binding, and validates the return value. A missing provider, unknown identity, binding mismatch, missing or extra argument, schema failure, or missing method fails at the boundary before entering or after leaving business code.

The lookup provider's `register()` supplies both the stable declaration and the default resolver; `configure()` supplies a resolver owned by Host composition that may execute asynchronously and is scoped to an effect lifetime. Configuration may precede provider mounting; without a provider, invocation still fails with `lookup-unavailable`, and unloading the configuration restores the provider's default policy. API Remotes owns the standard `agentFor()` semantics for `agent` and `session`: it reuses a live Agent, automatically resumes ordinary cold sessions, deduplicates concurrent resumes, and rejects identities owned by subagent routing; the `session` lookup returns that Agent's Session. The Web API Proxy supplies its Agent defaults and scope setup, then consumes the same resolver for legacy methods. Resume failures and ownership fences pass through unchanged as existing RPC errors rather than being collapsed into the Gateway's `internal` error.

Unloading a Client contribution removes its descriptors and concrete methods together, aborts its in-flight calls, and makes stale method handles retained by external code reject further calls. A strict endpoint withdrawn on the Host also does not degrade to SRC inference, preventing a hot unload from silently weakening validation.

## SRC development fallback

When the Host starts from source through `node --import tsx/esm`, it does not execute the TypeRT compiler plugin. Standard decorator initializers still record the method name and invocation mode in a module-private `WeakMap`, while `GatewayService` or `bindTypeRTGateway()` supplies the explicit service binding; the Gateway can therefore construct a weaker temporary descriptor without starting a `ts.Program`.

The SRC fallback parses simple parameter names from the live function. When a parameter name matches the `parameter` of a registered lookup, such as `agent` or `session`, it uses the lookup's `agentId` or `sessionId` wire field and resolves the object on the Host; other parameters are checked only for cycle-free, JSON-safe data with no special prototype. `@RemoteContext` directly uses the wire field of a registered Host Context provider. SRC does not read TypeScript types, generate Zod schemas, infer optional parameters, or support destructuring, default values, rest parameters, or duplicate parameter names.

SRC solves only dispatch for a Host process running from source. The Client does not discover decorators from the running Host, and the Client API refuses to mount SRC descriptors that lack strict codecs; its types, codecs, and Remote registration values always come from the most recently generated `lib/typert.remote-client.*` artifacts.

## Development mode

A complete build generates Host contracts before compiling the Host, Client, and Web, so it is the deterministic entry for creating or refreshing all artifacts:

```sh
pnpm run build
```

Web development normally starts the source Host after one complete build and runs the Client plugin watcher in another terminal:

```sh
pnpm run dsh -- web --dev
pnpm run dev:web
```

`dsh` starts the Host source through tsx, so the Host can use the SRC fallback; `dev:web` watches only Client plugins with a `dshClient` declaration and rewrites their `lib/client.js`. It does not analyze Host decorators or generate Remote Client DTS.

Changing only a Remote method's implementation body without changing its contract does not require regenerating the TypeRT files. After adding or removing a decorator or changing an export name, namespace, parameter, return value, lookup, Context, or cancellation signature, regenerate the strict contracts before the Client bundle consumes the new artifacts:

```sh
pnpm run build:lib:contracts
```

The running Client watcher consumes these generated files when it rebundles; without a watcher, run `pnpm run build:lib:client`. Recompiling only the frontend source cannot infer new types from Host decorators. `pnpm run typecheck` includes `build:lib:contracts` as a prerequisite, and CI and release builds also use the strict generation pipeline.

## Boundaries

Remote handles only unary method calls with one request and one result. Session event streams, pagination, incremental reduce, projection, and entity substreams require a separate data protocol and registration model; even when they reuse the Connection, they must not masquerade as Remote methods or enter invocation descriptors.

The API layers are organized as `remotes → gateway → connection → webserver`. The BFF and TypeRT RPC layers live under `packages/api`; Connection and WebServer remain at `packages/client/connection` and `packages/host/webserver`, with service contracts that permit a later package-only move to `packages/api`. The legacy API Proxy remains at `packages/host/apiproxy` as the fallback for endpoints not yet migrated to Remote.

Lookup policy is currently configured per key, so all `agent` or `session` parameters share the cold-resume behavior. If a Remote endpoint must accept live objects only, an explicit per-parameter or per-endpoint policy must be added later; the business method must not guess whether the object came from restoration.
