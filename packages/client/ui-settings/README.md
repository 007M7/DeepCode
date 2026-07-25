# @deepseek-ai/dsh-client-ui-settings

Settings shell plugin: the sidebar trigger row and the modal settings panel occupying `sidebar.settings`; declares the `settings.section` list slot that section plugins contribute pages into. The shell projects the section ledger into navigation and renders only the active section (`only` filtering).

## Model Experience

None, as the settings shell serves browser UI composition; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Panel is browser-preference scope only** — host-side settings (permission mode, tool-call mode) render as skeletons in the General section; no RPC surface exists yet.
