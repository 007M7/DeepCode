# @deepseek-ai/dsh-client-ui-settings

Settings shell plugin: a pure composition face. It occupies `sidebar.settings` with the trigger chrome and the modal settings panel, and declares the slots registrants fill: `settings.trigger` / `settings.header` / `settings.close` (chrome content) and `settings.section` (one page per feature). The shell ships no copy and reads no locale state — all text arrives from registrants (ui-settings-general owns chrome and General; features own their sections and rows), so the section ledger bump is its only re-render trigger.

## Model Experience

None, as the settings shell serves browser UI composition; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Panel is browser-preference scope only** — host-side settings surfaces (permission mode, tool-call mode) have no RPC backing yet; their skeletons live in ui-settings-general.
