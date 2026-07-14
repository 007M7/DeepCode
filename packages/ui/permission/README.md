# @deepseek-ai/dsh-permission

User-facing permission presets through `ctx.permission` ([`PermissionService`](src/index.ts)). Each configured name bundles `bash/sandbox-mode` with `approval/policy`; the defaults are `workspace-write` (`workspace-write` + `ask`) and `danger-full-access` (`danger-full-access` + `never`). The ACP bridge exposes them as one `Permissions` select, while sandbox execution and approval continue to consume their own knobs.

`set(session, name)` records a changed selection in a log-only `permission/preset` event, then calls each knob's setter only when its effective value changes. The selection event precedes the knob events and preserves user intent when presets share a bundle; a net-zero selection appends nothing. `current(events)` prefers a still-matching recorded selection, then the first matching table entry, and otherwise returns `custom`. Clients may display `custom` as the current value, but cannot select it.

The service requires a confining `ctx.bash` executor and `ctx.approval`. A table entry named `custom` throws at load; composition defaults outside the table instead make a zero-event session derive `custom`. See [the acp-agent example](../../../examples/acp-agent/) for the composition and [the sandbox RFC](../../../docs/rfc/implemented/feature/2026-07-06-sandbox.md) for the switching design.
