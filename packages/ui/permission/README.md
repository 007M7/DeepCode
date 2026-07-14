# @deepseek-ai/dsh-permission

User-facing permission presets. Owns the `ctx.permission` service ([`PermissionService`](src/index.ts)): a config-defined preset table — by default `workspace-write` (`workspace-write` + `ask`) and `danger-full-access` (`danger-full-access` + `never`) — where each name bundles the two mechanism knobs, `bash/sandbox-mode` and `approval/policy`. The product surface (the ACP bridge's single `Permissions` select) advertises `names` and calls `set()`; the mechanism tiers stay orthogonal capabilities that never learn the product vocabulary.

A switch WRITES THROUGH: `set(session, name)` appends one log-only `permission/preset` event when the name differs from the session's current preset (the audit fact reverse-mapping cannot recover — two presets may share knob values and differ only in composed policy, the planned `agent` preset being the standing example), then each knob event through its own THE-write-path setter, skipping values the session already effectively has — a net-zero switch appends nothing. The current preset DERIVES from the effective knob values (fold ?? composition default per knob): the last-chosen preset when its bundle still matches (presets may share bundles — the fold breaks the tie), else the first matching table entry, else the reserved `custom` — the honest not-a-preset state, shown as the current value only while it holds, switchable FROM and never a target. Every existing knob consumer (executor stamping, the approval gate, narrators, resume) keeps reading its own fold, untouched.

Composing it requires a confining `ctx.bash` executor and the `ctx.approval` seam; a table entry named `custom` throws at load (the name is reserved), while composition defaults outside the table are not an error — a zero-event session simply derives `custom`. See [the acp-agent example's default tree](../../../examples/acp-agent/) for the composed leaf and [the sandbox RFC § Per-session modes](../../../docs/rfc/implemented/feature/2026-07-06-sandbox.md) for the switching design this layers over.

## Model Experience

Indirectly, through `dsh-user-approval` and `dsh-tool-bash`, which render the approval-policy prompt, switch notice, and sandboxed tool outcomes selected by this service's knob events; `permission/preset` itself is log-only.

## Known Limitations and Deferred Work

- **Only two mechanism knobs are bundled** — presets select sandbox mode and approval policy; an agent/profile choice is not part of `PresetSpec` yet.
- **`custom` is derived-only** — callers can switch away from an unmatched knob combination but cannot target or persist a named custom preset through this service.
- **The preset table is process-level** — configuration is fixed for the plugin lifetime; changing available presets requires reloading the plugin.
