# @deepseek-ai/dsh-client-ui-model

English | [中文](README.zh.md)

Model selection plugin, browser half: TWO entries over ONE per-session directory owned by `ModelService` (`ctx.models`). The `/model` popupSelect contribution (registered through `ctx.command`) and the composer's named `conversation.input.model` seat both load the session's advisory directory through `session.models` and submit through `session.selectModel` via the same `ModelDirectory` instance. The compact composer trigger opens a two-level Model/Effort menu: models stay provider-grouped, while the selected exact model supplies its adapter-owned effort names, descriptions, and default. The Host-reported provider/model/reasoning target is the single fact both entries echo; `/model` applies the selected model's default effort, and the composer can then choose any advertised effort. Directory loads and selections share a generation counter so an older response never overwrites a newer one; a connection reset drops every resident projection and repulls the Host-restored target before display. Provider-local metadata failures list inline while usable groups stay selectable, and selection failures retain the prior target and directory. Directories are per-session, resolved lazily through `ctx.models.directoryFor(sessionId)`, and disposed with the session scope.

The `/client` export surface is the plugin body (`apply`/`inject`), `ModelService`, `ModelDirectory` with its state shape, and the seat's injected face type.

## Model Experience

Indirectly, through the `session.selectModel` RPC both entries submit: the Host snapshots the selected provider/model/reasoning target at the next prompt-assembly boundary, so the following request uses the chosen route and effort while a running step keeps its assembled target. The selection becomes durable only when the existing request header records a request that consumes it; menu interaction adds no prompt content.

#### KV Cache effect

Switching the route can reduce or invalidate provider-side cache reuse for subsequent requests; the prompt prefix itself is untouched.

## Known Limitations and Deferred Work

- **No create-time selection** — both entries address an existing session's agent; there is no draft-phase model choice to fold into session creation (the seed order at the host's `targetFor` documents where such a tier would go).
- **Directory names are presentation-only** — selection and persistence use provider/model/effort ids; a provider whose catalog or exact-model metadata lookup fails lists as an unselectable failure row until reload.
- **No arbitrary effort input** — the composer offers only the exact model's adapter-advertised levels; an adapter without reasoning metadata leaves the Effort row absent.
