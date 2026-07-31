# @deepseek-ai/dsh-client-ui-settings-general

English | [中文](README.zh.md)

Settings ownerless-copy plugin: registers everything on the Settings surface that belongs to no single feature — the shell's trigger/header/close chrome content, the General section (`settings.general.item` slot plus the Tool Call skeleton), and the `settings` dictionaries. Feature-owned rows (Permission, Language, Appearance) and sections (Models) stay with their feature packages.

## Model Experience

None, as the plugin renders browser settings UI; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Tool Call is a display skeleton** — its backing host setting does not exist yet, so the cubes write nothing. When it gains real backing, the row moves to its owning feature plugin per the self-registration doctrine.
