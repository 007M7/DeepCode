# dsh-agent-presets

English | [中文](README.zh.md)

Per-preset agent composition. A **preset** is a directory holding one `agent.cordis.yml`; the roster mounts it ONCE per process under a standing scope, and each session that names it joins by having its agent scope key parented to the mount's (`dsh-scope`'s parent chain). The mount's tools, prompt sections, and projection units exist exactly once and cover every joined agent — its plugins key their state by Session/Agent, so sessions stay apart inside one shared instance — and a host reader with no agent at all (a cold transcript read) resolves the same standing registrations by preset id.

The mechanism is two seams. Entry contexts chain to the context a subtree was plugged into, and both [`dsh-tools`](../../core/tools/README.md) and [`dsh-system-prompt`](../../core/system-prompt/README.md) file registrations into the calling context's scope layer — so the standing mount's contributions land in the PRESET's layer. What carries them to each session is `dsh-scope`'s parent chain: an agent's views resolve `agent → preset → global` (nearest shadowing farthest), and the mount's listeners are admitted for every agent parented under it while a sibling preset's stay deaf.

## Service: `AgentPresets` (ctx key: `agentPresets`)

Discovery is unmemoized: `list()` and `resolve()` re-read the roots on every call, so a preset authored while the process runs is visible immediately and a deleted one disappears from the next read.

- `ctx.agentPresets.defaultId: string` The preset id mounted when a caller names none.
- `ctx.agentPresets.list(): Promise<AgentPreset[]>` Every preset the configured roots currently supply, earlier root winning a duplicate id.
- `ctx.agentPresets.resolve(id?): Promise<AgentPreset>` One preset by id, defaulting to `defaultId`. Throws naming the available ids when no root supplies it.
- `ctx.agentPresets.mount(agentCtx, id?): Promise<AgentPreset>` Compose one agent from a preset — ensure its standing mount (single-flight) and parent the agent's scope key to it — returning the preset for the caller to record.
- `ctx.agentPresets.recompose(agentCtx, id): Promise<AgentPreset>` Re-link one agent to a different preset's standing composition. Valid only while the agent has produced nothing — **the caller owns that check**; the new mount is ensured before the link moves, so a failure leaves the agent as it was.
- `ctx.agentPresets.standingKeyFor(id?): Promise<ScopeKey>` The standing scope key a host reader with no agent (a cold transcript read) resolves preset registrations in; ensures the mount without starting an agent, session, or turn.
- `ctx.agentPresets.authorable: boolean` Whether any configured root has `user` trust, and therefore whether a preset can be written at all.
- `ctx.agentPresets.read(id): Promise<string>` One preset's composition text, exactly as stored.
- `ctx.agentPresets.write(id, content): Promise<void>` Create or replace a locally authored preset. Edits reach only future generations: the standing pointer drops, sessions already joined keep the mount they run on.
- `ctx.agentPresets.remove(id): Promise<void>` Delete a locally authored preset; joined sessions keep their standing mount. Clears the user default when it named the preset just deleted: storing a default that does not exist yet is deliberate, but one this call removed will never be supplied again and would fail every session created without an explicit pick.

`AgentPreset` carries `id` (the directory name), `trust` (`system` or `user`, from the root it was found under), and `path` (the absolute composition file).

### Where to call `mount()`

The agent factory's `setup(agentCtx)` hook is the one supported call site. Only there is the join installed while the agent is still unpublished, so a rejected composition rolls the whole creation back rather than leaving a half-composed session. The standing subtree is owned by the roster service's own fiber — deliberately its UNTRACED context, because a subtree minted from a traced `this.ctx` resolves every service through the caller's shadow fiber instead of each entry's own inject store — so it survives every agent and unwinds only with the whole tree. A settled mount is permanent for the process: the composition a running session joined must outlive its file changing or disappearing underneath it, so file edits reach only future generations.

### Which preset a session runs

The creation header names the preset a session STARTED with; `resolveSessionPreset(session)` names the one it RUNS. They differ whenever a blank session switched, so every reconstruction path — the summary a picker reads, a resume, a fork — resolves rather than reading the header.

The header stays frozen because it is a creation fact. A switch is an `agent-preset/selected` session event appended after the swap commits, which is what the model-visible ⟺ logged rule requires: the preset decides the tool schemas and prompt sections the model sees, so it has to be reconstructable from the log. Reading the header alone would rebuild a switched session under the composition it was created with, replaying history the new tool set cannot act on — the exact hazard the blank-only lock exists to prevent.

### Switching a blank agent

`recompose()` unmounts the installed subtree and mounts the new one, because two compositions cannot coexist — both would register the same tool names into one layer. A failed mount restores the previous composition rather than leaving the agent with nothing, and an unknown id is rejected before anything is torn down.

The restriction to a produced-nothing agent is a product rule, not a mechanical one: swapping tools mid-conversation would leave logged tool calls the new composition cannot make. The gateway enforces it at the wire ([`dsh-apiproxy`](../../host/apiproxy/README.md) answers `agent-preset-locked`), which is where session history is in hand.

## Authoring

A locally authored preset is a directory under the first `user` root holding one `agent.cordis.yml`. `write()` refuses three things before anything lands:

- **An id that is not `[a-z0-9][a-z0-9-]*`.** The id becomes a directory name, so containment is a property of the id itself rather than of a path check after the fact — `../escape`, `a/b`, and an absolute path are all rejected as ids.
- **Text that is not a Cordis entry list.** The content is parsed with the loader's own schema and dialect (`!!js` included), so a save cannot leave a file no session could load. Shape only: a composition naming a plugin that does not exist is accepted here and fails at the next session that selects it.
- **A preset that ships with the deployment.** Overwriting one would remove the known-good composition a broken local preset is compared against. `remove()` refuses the same.

Writes are atomic and owner-only (`0o600`, in a `0o700` directory), and the root is created on first write — a deployment configuring a user root that does not exist yet is the normal first-run state.

### How a preset's rows resolve

A row's **package name** resolves from the host composition, not from the preset directory. The Loader normally resolves an entry against its own tree's `baseUrl`, which for a preset is wherever the composition file sits; a locally authored preset lives under the user's home, where Node's upward `node_modules` walk never reaches the harness, so every `@deepseek-ai/dsh-*` row would fail to import. The mount records the host base before plugging the subtree and sends bare specifiers there.

A **relative** path still resolves from the preset's own directory, so a preset's own plugin files and skill directories travel with it.

### Display metadata

A preset may publish display text in an optional `preset.yml` beside its composition:

```yaml
name: 极简模式
description: 只向模型呈现 bash 与 str_replace_editor，适合 benchmark 与最小复现。
```

It carries display text ONLY. `id` is the directory name and `trust` comes from the root the preset was discovered under, so neither is writable here — otherwise a locally authored preset could name itself into the shipped set. It is a separate file because the composition is a top-level list of plugin rows: YAML cannot carry sibling keys beside it, and a fake metadata row would hand the Loader something to load.

Every read failure degrades to no metadata — absent, malformed, wrongly typed, or blank all mean the same thing, and a picker falls back to the id. Presentation is not capability: a preset with a broken name still mounts.

## Config

| Field | Default | Meaning |
|---|---|---|
| `default` | required | Preset id mounted when a caller names none |
| `roots` | `[]` | Scanned directories in precedence order; each supplies `path` (a leading `~` expands) and `trust` (defaults to `user`) |

An absent root supplies no presets rather than failing: the user root does not exist until the first locally authored preset, and naming a default no root supplies already fails loud at resolution.

### The default preset is a user setting

When a settings provider is composed, this plugin registers the `agent-presets` namespace with `config.default` as its composition base, so the user document layers over the deployment's engineering default:

```yaml
agent-presets:
  default: minimal
```

The value is read per resolution rather than snapshotted, so a hot-reloaded document takes effect on the next session created and every running session stays on the preset it was composed from. Clearing the user field re-inherits the composition default. A default naming a preset no root supplies is stored without complaint and fails at the next `resolve()` — the roster is a live directory, so a name absent now may exist by the time a session asks for it.

## What a mount rejects

A directly-plugged subtree is absent from `ctx.loader.entries()`, so no boot audit covers it. `mount()` therefore proves the result usable itself, and rejects three things.

**An unscoped target.** Mounting into a context that carries no agent scope would register the preset's tools globally, for every agent in the process.

**A row that never became usable.** The loader already rejects a row whose module failed to import or whose plugin threw; what remains is a row still waiting for a service the composition never supplies, which the audit names.

**A row that published a service into the root realm.** Such a service is process-global, so the second preset publishing the same name collides with the first, and a host reader would resolve one preset's instance for every session. A preset that genuinely owns a service puts it behind an `isolate` realm — entry-local realms keep two presets' same-named services apart exactly as they once kept two sessions' apart — or the service belongs in the host composition instead.

The package invariant re-checks that last rule on every service notification, because a row that publishes from a timer or an asynchronous continuation would escape the one-shot audit.

## A preset file is an input, never a persistence target

The Loader writes a tree back to its source file whenever it decides the config changed, and a row disposing its own fiber is enough to decide that: the entry is marked `disabled` and the tree is written. Inherited, that would burn one session's runtime state into a file every session shares — comments stripped by the YAML round trip, and a `writeFile` rejection inside a `setTimeout` for a read-only shipped preset.

The mounted subtree therefore overrides `write()` as a no-op. Nothing in this package writes a composition; authoring one is a separate, explicit operation.

## Trust

Presets are compositions, so a preset is exactly as privileged as the plugins it names. A `user` preset — authored by a person or by an agent — carries the same trust as shell access; the `trust` field exists so consumers can present that difference, not to enforce it.

## Model Experience

Indirectly, through the plugins a standing composition registers, which own every tool schema and prompt section the preset makes visible to the agents joined to it.

#### KV Cache effect

Prefix-stable for the life of an agent: a composition is installed once, before the agent is published and therefore before its first request, and is never re-read while the agent runs. Choosing a different preset for a new session establishes a different prefix for that session alone and cannot invalidate reuse for any session already running.

## Known Limitations and Deferred Work

- **A preset cannot be changed once a session has produced anything** — `recompose` re-links a BLANK session's parent scope to another standing mount, and only a blank one: switching a composition that already ran would strand tools the model has called. Changing the default affects only sessions created afterwards.
- **A standing mount reads its file once per generation** — the first session to name a preset fixes its composition until an authoring `write()`/`remove()` drops the pointer or the whole tree unloads; sessions already joined keep their generation, and nothing reclaims a superseded one while the process lives (bounded by how often compositions are edited, not by sessions).
- **A written composition is never mounted to validate** — `write()` checks shape, not resolvability, so a preset naming a missing plugin is stored and fails at the next session that selects it.
- **Display names are the directory id** — a preset carries no manifest, so pickers and settings surfaces show the id until a consumer needs richer metadata.
- **Root scans are not watched** — every read hits the filesystem instead, which keeps the roster fresh but puts one `readdir` per root on each `list()`.
