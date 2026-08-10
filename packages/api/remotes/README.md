# @deepseek-ai/dsh-api-remotes

English | [中文](README.zh.md)

Two-sided BFF for Host Remote capabilities selected by this application. The Host entry owns Agent/Session identity policy; the Client entry imports generated `/remote` artifacts as runtime values, mounts each contribution through `ctx.remote.$mount()`, and re-exports their declaration merges. Client business packages depend on this facade rather than the Gateway implementation or individual Remote runtime entries.

`createApiRemoteAgentResolver()` reuses live Agents, resumes ordinary cold sessions, deduplicates concurrent resumes, preserves the subagent ownership fence, and configures the same resolver for TypeRT `agent` and `session` lookups. The standard Web API Proxy supplies its Agent defaults and scope setup, then uses the returned resolver for legacy methods, so migrated and unmigrated methods share one policy implementation.

The current Client assembly mounts only the Goal Remote contribution. Cordis effect ownership withdraws every contribution when this assembly unloads, while `@deepseek-ai/dsh-api-gateway/client` owns descriptor validation, traced namespace Services, direct and scoped methods, invocation, and cancellation. The Client entry consumes the shared `TypeRTClientRemote` interface through Cordis and does not import the concrete Gateway. It re-exports the Gateway Client face's declaration merges type-only, so a consumer reaching the forwarded-event vocabulary through this facade gains no runtime edge to the Gateway implementation.

This package contains no transport or Host service discovery logic. Its Client face can be reused by Web or a future TUI that provides the same React-free `ctx.remote` contract.

## Forwarded Host events

`src/types.ts` holds `API_REMOTE_FORWARDED_EVENTS`, the allowlist of Host cordis events this application forwards to consumers verbatim — no projection, no redaction, no renaming — and therefore the legal key set of `ctx.remote.$on`. Forwarding one more event is an entry in that array and nothing else: the type projection, the consumer key face, and the Host forwarding loop all derive from it.

The listener signature is not restated here. Each allowlisted event's cordis `Events` declaration lives in its owner package's client-safe `./types` export (`dsh-commands`, `dsh-credentials`, `dsh-settings`), and both faces of this package pull those declarations in, so "forwarded verbatim" holds by construction rather than by proof. The Host face additionally asserts the list against `TypeRTForwardableEvent`, which rejects a name that is not a declared event, one that binds an AgentScope, and one whose shape is not one-way.

## Build boundary

An ordinary repository package belongs to one TypeScript face: Host packages are registered in the root `tsconfig.host.json`, and Client packages in the root `tsconfig.client.json`. `api-remotes` is the only deliberate exception because its Host entry must participate in the Host TypeRT graph, while `src/client/index.ts` cannot compile until Host tsdown has generated the business packages' `/remote` declarations.

This package's root `tsconfig.json` is only a solution that references `tsconfig.host.json` and `tsconfig.client.json`. The Host aggregate and direct Host consumers reference the former, while the Client aggregate and direct Client consumers reference the latter; the package-root solution must not enter either aggregate's dependency graph. The two projects own disjoint source files and `.tsbuildinfo` files but share the `lib/types` output directory, with one deliberate exception: `src/types.ts` is listed in BOTH faces' `files`, because the forwarded-event allowlist is the single control point over what a consumer can receive, and the Host forwarding loop and the Client `ctx.remote.$on` key face must read one declaration rather than two that could drift.

That exception is not just a `files` entry. The root `tsconfig.base.json` maps `@deepseek-ai/dsh-api-remotes/types` to `src/types.ts` — the source plane, like every other workspace subpath and unlike the generated `/remote` artifacts, which have no `paths` entry and resolve through `exports` to built output. Both faces therefore admit that one source file into their own program and each emits its own `lib/types/types.js`/`.d.ts` over the other's. The two emissions are byte-identical because they compile the same source, and the `.tsbuildinfo` files stay independent. No gate enforces the faces' source-file disjointness — `scripts/project-reference-faces.ts` only checks that a reference into a split project names the matching face — so this paragraph is the only thing standing between the next reader and the conclusion that the double listing is a mistake.

The package-local `clientBundle(..., { hostPhase: true })` makes Host tsdown bundle the Host entry and the later Client tsdown bundle only the browser entry. Ordinary Client plugins remain single Client projects and produce both their Node loader entry and browser bundle during Client tsdown; do not copy this package's split merely because a package has both `src/index.ts` and `src/client/index.ts`.

## Model Experience

None, as this BFF selects Remote application methods and identity policy but registers nothing model-facing.

#### KV Cache effect

No direct effect; mounted Host capabilities own any model-visible behavior they trigger.

## Known Limitations and Deferred Work

- The capability set is fixed by explicit build-time value imports; the Client does not discover the Host's active Services or Remote definitions at runtime.
- Additional capabilities require an explicit `/remote` value import and mount in this assembly.
- The standard Web Host supplies resume defaults and Agent-scope setup from the legacy API Proxy until that remaining BFF configuration moves into `api-remotes`.
