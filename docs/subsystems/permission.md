# Permission Presets

English | [中文](permission.zh.md)

The permission-preset layer of [dsh-permission](../../packages/ui/permission) (`ctx.permission`, `PermissionService`) bundles the two independent enforcement knobs — [sandbox mode](sandbox.md) (`sandbox/mode`) and [approval policy](approval.md) (`approval/policy`) — into named presets a client offers as one Permissions selector. It is one optional capability, not part of the agent-loop spine, and it owns no enforcement: execution, prompt narration, and replay keep reading their knob folds, and a preset switch only records intent and writes through each knob's canonical setter. The [package README](../../packages/ui/permission/README.md) owns composition status and limitations; the [sandbox switching design](../../.agents/notes/implemented/feature/2026-07-06-sandbox.md) owns the rationale.

Source: [`packages/ui/permission/src/index.ts`](../../packages/ui/permission/src/index.ts)

## The preset table

A preset is a table key mapping to one sandbox/approval bundle plus optional client presentation; the default table ships `workspace-write` (`workspace-write` + `ask`) and `danger-full-access` (`danger-full-access` + `never`).

```ts type-equiv
/** One preset's sandbox/approval bundle and optional client presentation. */
interface PresetSpec {
  /** The `sandbox/mode` value the preset writes through. */
  sandbox: SandboxMode
  /** The `approval/policy` value the preset writes through. */
  approval: ApprovalPolicy
  /** The display label a client shows for this preset; the raw table key when omitted. */
  name?: string
  /** One user-facing sentence on what the preset means; omitted when not configured. */
  description?: string
}
```

```ts type-equiv
/** The {@link PermissionService} config: the deployment's preset table. */
interface Config {
  /**
   * The preset table: name → knob bundle. Defaults to `workspace-write`
   * (workspace-write + ask) and `danger-full-access` (danger-full-access +
   * never). The name `custom` is reserved for the derived not-a-preset state.
   */
  presets?: Record<string, PresetSpec>
}
```

The service requires a confining `ctx.bash` executor and `ctx.approval`, and misconfiguration fails at plugin load: a table entry named `custom` throws (the name is reserved for the derived not-a-preset state), and composing over a bash executor that does not confine (no `sandboxMode` capability fact) throws, because presets bundle a sandbox mode.

## Current preset and the derived `custom`

`current(events)` derives the effective preset from the knobs, not from its own event alone: it folds the session's effective sandbox mode (falling back to the executor's configured mode) and effective approval policy (falling back to the approval service config, then `ask`), prefers a still-matching recorded selection, then the first matching table entry in declaration order, and otherwise returns `CUSTOM_PRESET` (`'custom'`). `custom` is derived-only: clients may display it as the current value, but it is never a switch target or an event payload.

`names` lists the switchable presets in table declaration order; `optionOf(name)` builds the option a client renders for a table key (label falls back to the key) or for `custom`, and throws for any other name.

```ts type-equiv
/** The select-option shape a presentation layer advertises for one preset (or for the derived `custom` state). */
interface PresetOption {
  /** Stable option value: the table key, or `custom`. */
  value: string
  /** The display label. */
  name: string
  /** One user-facing sentence on what the value means. */
  description?: string
}
```

## Switching and the `permission/preset` event

`set(session, name)` resolves the preset (unknown names throw), appends a log-only `permission/preset` event unless `name` is already the effective preset, then writes each knob through its own setter — `setSandboxMode` from [dsh-sandbox-policy](../../packages/sandbox/sandbox-policy) and `setApprovalPolicy` from [dsh-user-approval](../../packages/ui/user-approval) — only when that knob's effective value changes. The selection event precedes the knob events in the same turn, and re-selecting the effective preset appends nothing at all.

`permission/preset` is durable, log-only user intent: it stays out of the model transcript (the knob events own the model-visible consequences through their consumers), and it exists so `current()` can preserve WHICH preset the user chose when two presets share a bundle; `effectivePermissionPreset(events)` folds the last one, and replay needs no catch-up state. The complete event declaration is in the [persistence log event catalog](../persistence-catalog.md); the method signatures are in the generated [service catalog](../cordis-catalog/services.md#ctxpermission--permissionservice).
