# @deepseek-ai/dsh-client-ui-settings-general

English | [中文](README.zh.md)

Settings ownerless-copy plugin: registers everything on the Settings surface that belongs to no single feature — the shell's trigger/header/close chrome content, the General section (Permission/Tool Call skeleton rows + the `settings.general.item` slot declaration), and the `settings` dictionaries. Feature-owned rows (Language, Appearance) and sections (Models) stay with their feature packages.

## Model Experience

None, as the plugin renders browser settings UI; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Permission and Tool Call are display skeletons** — the backing host services and RPC methods do not exist yet; the controls are disabled and write nothing. When they gain real backing, each moves to its owning feature plugin per the self-registration doctrine.
