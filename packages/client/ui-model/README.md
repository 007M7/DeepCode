# @deepseek-ai/dsh-client-ui-model

English | [中文](README.zh.md)

Model selection plugin, browser half: TWO entries over ONE per-session directory owned by `ModelService` (`ctx.models`). The `/model` popupSelect contribution (registered through `ctx.command`) and the composer's named `conversation.input.model` seat (a compact trigger + upward provider-grouped menu, figma 313:14108's ToggleButton chrome) both load the session's advisory directory through `session.models` and submit through `session.selectModel` via the same `ModelDirectory` instance — the host-reported current target is the single fact both surfaces echo, so a switch made in either entry is what the other shows next. Directory loads and selections share a generation counter (an older response never overwrites a newer one); a connection reset drops every resident projection and repulls the Host-restored target before displaying it again. Provider-local catalog failures list inline while usable groups stay selectable; whole-request and selection failures surface on each entry's own retry face (the popup shell's error/retry, the seat menu's inline error) without forking the state. Directories are per-session, resolved lazily through `ctx.models.directoryFor(sessionId)`, and disposed with the session scope.

The `/client` export surface is the plugin body (`apply`/`inject`), `ModelService`, `ModelDirectory` with its state shape, and the seat's injected face type.

## Model Experience

Indirectly, through the `session.selectModel` RPC both entries submit: the host snapshots the selected provider/model pair at the next prompt-assembly boundary, so the following request routes (and stamps its prompt variables) with the chosen target while a running step keeps its assembled one — the directory, both menus, and every selection interaction stay client-side and never enter the session log.

#### KV Cache effect

Switching the route can reduce or invalidate provider-side cache reuse for subsequent requests; the prompt prefix itself is untouched.

## Known Limitations and Deferred Work

- **No create-time selection** — both entries address an existing session's agent; there is no draft-phase model choice to fold into session creation (the seed order at the host's `targetFor` documents where such a tier would go).
- **Directory names are presentation-only** — selection and persistence use provider/model ids; a provider whose catalog lookup fails lists as an unselectable failure row until reload.
- **The seat shows no effort level** — the figma mock's `High` text has no wire concept behind it yet; the trigger renders the model name alone.
