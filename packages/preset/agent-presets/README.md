# dsh-agent-presets

English | [中文](README.zh.md)

Per-session agent composition. A **preset** is a directory holding one `agent.cordis.yml`; mounting it under an agent's scope context gives that one session its own tools, prompt sections, and other model-facing contributions, while every other live session keeps its own.

The mechanism is entirely Cordis: entry contexts chain to the context a subtree was plugged into, and both [`dsh-tools`](../../core/tools/README.md) and [`dsh-system-prompt`](../../core/system-prompt/README.md) file registrations into the calling context's scope layer. Mounting a composition under `agent.ctx` therefore makes it that agent's alone, and unwinds it with the agent, without any new layering in those registries.

## Service: `AgentPresets` (ctx key: `agentPresets`)

Discovery is unmemoized: `list()` and `resolve()` re-read the roots on every call, so a preset authored while the process runs is visible immediately and a deleted one disappears from the next read.

- `ctx.agentPresets.defaultId: string` The preset id mounted when a caller names none.
- `ctx.agentPresets.list(): Promise<AgentPreset[]>` Every preset the configured roots currently supply, earlier root winning a duplicate id.
- `ctx.agentPresets.resolve(id?): Promise<AgentPreset>` One preset by id, defaulting to `defaultId`. Throws naming the available ids when no root supplies it.
- `ctx.agentPresets.mount(agentCtx, id?): Promise<AgentPreset>` Compose one agent from a preset and return the preset that was mounted, for the caller to record.

`AgentPreset` carries `id` (the directory name), `trust` (`system` or `user`, from the root it was found under), and `path` (the absolute composition file).

### Where to call `mount()`

The agent factory's `setup(agentCtx)` hook is the one supported call site. Only there is the composition installed while the agent is still unpublished, so a rejected mount rolls the whole creation back rather than leaving a half-composed session. The subtree is owned by `agentCtx`'s fiber, so it unwinds with the agent and the caller receives no disposer.

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

**A row that published a service into the root realm.** Such a service is process-global rather than per-session, so the second session mounting the same preset collides with the first. A preset that genuinely owns a service puts it behind an `isolate` realm — entry-local for one session's private instance, or a shared label when several sessions should share one — or the service belongs in the host composition instead.

The package invariant re-checks that last rule on every service notification, because a row that publishes from a timer or an asynchronous continuation would escape the one-shot audit.

## Trust

Presets are compositions, so a preset is exactly as privileged as the plugins it names. A `user` preset — authored by a person or by an agent — carries the same trust as shell access; the `trust` field exists so consumers can present that difference, not to enforce it.

## Model Experience

Indirectly, through the plugins a mounted composition registers, which own every tool schema and prompt section the preset makes visible to its one agent.

#### KV Cache effect

Prefix-stable for the life of an agent: a composition is installed once, before the agent is published and therefore before its first request, and is never re-read while the agent runs. Choosing a different preset for a new session establishes a different prefix for that session alone and cannot invalidate reuse for any session already running.

## Known Limitations and Deferred Work

- **A preset cannot be changed on a live agent** — the mount happens once during creation, so switching a running session's composition would mean unwinding its subtree mid-turn, dropping tools the model may already have called. Changing the default affects only sessions created afterwards.
- **Display names are the directory id** — a preset carries no manifest, so pickers and settings surfaces show the id until a consumer needs richer metadata.
- **Root scans are not watched** — every read hits the filesystem instead, which keeps the roster fresh but puts one `readdir` per root on each `list()`.
