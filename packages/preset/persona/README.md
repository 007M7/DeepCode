# dsh-persona

English | [中文](README.zh.md)

The agent persona as a composable row. One config field, one prompt section.

[`dsh-system-prompt`](../../core/system-prompt/README.md) owns the deployment persona as its own config and registers that section unconditionally, so a process has exactly one. An [agent preset](../agent-presets/README.md) cannot mount the prompt registry itself — without a row of its own, a preset could change an agent's tools but never its identity. This package is that row.

## Scope-only

Mounting this row outside an agent scope collides with the registry's own `deployment:persona` registration and fails loud. That is not a limitation to work around: the deployment persona already has an owner, and the whole point of this row is to shadow it for one agent. Mount it inside a preset composition, where the preset mount supplies the agent scope.

## Config

| Field | Default | Meaning |
|---|---|---|
| `text` | required | Persona prose rendered as the `deployment:persona` section |

`text` is a template, like any prompt section: complete `{{…}}` groups resolve strictly against registered prompt variables when the prompt renders, not when it assembles. Empty text still occupies the slot, so it shadows the deployment persona away entirely and then disappears at render.

## Model Experience

### The persona section

#### What the model sees

The `deployment:persona` section at order 0, immediately after the harness identity opener, carrying exactly this row's configured `text` with prompt variables resolved. For an agent whose preset mounts this row, it replaces whatever persona the deployment configured.

#### Token effect

Fixed for a given preset: the persona's own tokens on every request that agent makes, and none for any other agent. Empty text contributes nothing.

#### KV Cache effect

Prefix-stable for the life of an agent — the row mounts once, before the agent is published and therefore before its first request, and its text never changes while the agent runs. Two agents on different presets establish different prefixes from this section onward; neither can invalidate the other's reuse.

## Known Limitations and Deferred Work

- **No global mount** — the prompt registry owns the unscoped persona slot, so this row is usable only from a scoped composition. A deployment-wide persona change belongs in the `system-prompt` row's own config.
