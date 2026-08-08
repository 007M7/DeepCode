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

`AgentPreset` carries `id` (the directory name), `trust` (`system` or `user`, from the root it was found under), and `path` (the absolute composition file).

### Where to call `mount()`

The agent factory's `setup(agentCtx)` hook is the one supported call site. Only there is the join installed while the agent is still unpublished, so a rejected composition rolls the whole creation back rather than leaving a half-composed session. The standing subtree is owned by the roster service's own fiber — deliberately its UNTRACED context, because a subtree minted from a traced `this.ctx` resolves every service through the caller's shadow fiber instead of each entry's own inject store — so it survives every agent and unwinds only with the whole tree. A settled mount is permanent for the process: the composition a running session joined must outlive its file changing or disappearing underneath it, so file edits reach only future generations.

## Config

| Field | Default | Meaning |
|---|---|---|
| `default` | required | Preset id mounted when a caller names none |
| `roots` | `[]` | Scanned directories in precedence order; each supplies `path` (a leading `~` expands) and `trust` (defaults to `user`) |

An absent root supplies no presets rather than failing: the user root does not exist until the first locally authored preset, and naming a default no root supplies already fails loud at resolution.

## What a mount rejects

A directly-plugged subtree is absent from `ctx.loader.entries()`, so no boot audit covers it. `mount()` therefore proves the result usable itself, and rejects three things.

**An unscoped target.** Mounting into a context that carries no agent scope would register the preset's tools globally, for every agent in the process.

**A row that never became usable.** The loader already rejects a row whose module failed to import or whose plugin threw; what remains is a row still waiting for a service the composition never supplies, which the audit names.

**A row that published a service into the root realm.** Such a service is process-global, so the second preset publishing the same name collides with the first, and a host reader would resolve one preset's instance for every session. A preset that genuinely owns a service puts it behind an `isolate` realm — entry-local realms keep two presets' same-named services apart exactly as they once kept two sessions' apart — or the service belongs in the host composition instead.

The package invariant re-checks that last rule on every service notification, because a row that publishes from a timer or an asynchronous continuation would escape the one-shot audit.

## Trust

Presets are compositions, so a preset is exactly as privileged as the plugins it names. A `user` preset — authored by a person or by an agent — carries the same trust as shell access; the `trust` field exists so consumers can present that difference, not to enforce it.

## Model Experience

Indirectly, through the plugins a standing composition registers, which own every tool schema and prompt section the preset makes visible to the agents joined to it.

#### KV Cache effect

Prefix-stable for the life of an agent: a composition is installed once, before the agent is published and therefore before its first request, and is never re-read while the agent runs. Choosing a different preset for a new session establishes a different prefix for that session alone and cannot invalidate reuse for any session already running.

## Known Limitations and Deferred Work

- **A preset cannot be changed on a live agent** — the join happens once during creation, so switching a running session's composition would strand tools the model may already have called. Changing the default affects only sessions created afterwards.
- **A standing mount reads its file once per process** — the first session to name a preset fixes its composition until the whole tree unloads; edits reach only future generations, and nothing reclaims a superseded generation while the process lives (bounded by how often compositions are edited, not by sessions).
- **Display names are the directory id** — a preset carries no manifest, so pickers and settings surfaces show the id until a consumer needs richer metadata.
- **Root scans are not watched** — every read hits the filesystem instead, which keeps the roster fresh but puts one `readdir` per root on each `list()`.
