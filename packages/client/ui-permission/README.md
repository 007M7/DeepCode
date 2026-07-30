# @deepseek-ai/dsh-client-ui-permission

English | [中文](README.zh.md)

Permission preset selection plugin, browser half: a popupSelect DECORATION hung on the host `/permission` command (`ctx.command.decorate`). A decoration is not a second command — the host command keeps its slash-menu row, the argued path (`/permission <preset>` switches directly), and the durable lifecycle logging; the decoration replaces only the bare invocation with the picker: one flat preset list with the current value marked active and kebab-case preset names rendered as title-case labels (`workspace-write` → `Workspace Write`, the composer chip's display transform twin), where a pick submits the `/permission <preset>` command line. Options and the active mark read the session's `permissions` projection (the same host-computed select the composer chip renders), so both surfaces share one read source and one write path, and the pushed projection frame is the single confirmation both follow. The decoration is available exactly while the projection key is present; a permission-less composition shows no picker (a decoration never manufactures a catalog row).

The `/client` export surface is the plugin body (`apply`/`inject`).

## Model Experience

Indirectly, through the host `/permission` command the picker submits: a switch appends the whole-value knob events (`permission/preset`, `sandbox/mode`, `approval/policy`), which select the sandbox mode and approval policy later tool calls resolve. Picker interaction adds no prompt content.

#### KV Cache effect

No direct invalidation; the knob consumers own any request-prefix changes.

## Known Limitations and Deferred Work

- **No keyless snapshot exercises the picker yet** — the popup flow is covered by unit specs over fake faces; the assembled-transcript scenario rides the deferred approval/preset e2e work.
