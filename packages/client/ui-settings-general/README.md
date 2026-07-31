# @deepseek-ai/dsh-client-ui-settings-general

English | [中文](README.zh.md)

Settings ownerless-copy plugin: registers everything on the Settings surface that belongs to no single feature — the shell's trigger/header/close chrome content, the General section and its `settings.general.item` slot, and the `settings` dictionaries. Feature-owned rows (Permission, Language, Appearance) and sections (Models) stay with their feature packages.

## Model Experience

None, as the plugin renders browser settings UI; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- The General section has no built-in rows; each row appears only when its owning feature plugin is mounted.
