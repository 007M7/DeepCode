# @deepseek-ai/dsh-client-ui-settings-general

General settings section plugin: registers the `general` entry into `settings.section`. Language (中文/English) and Appearance (Light/Dark/System) are live preferences wired to `ctx.locale` / `ctx.theme`; Permission and Tool Call rows are visual skeletons with no write surface.

## Model Experience

None, as the section renders browser preference UI; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Permission and Tool Call are display skeletons** — the backing host services and RPC methods do not exist yet; the controls are disabled and write nothing.
