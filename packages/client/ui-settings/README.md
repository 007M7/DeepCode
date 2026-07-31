# @deepseek-ai/dsh-client-ui-settings

English | [中文](README.zh.md)

Settings shell plugin: a pure composition face. It occupies `sidebar.settings` with the trigger chrome and modal settings panel, and declares the slots registrants fill: `settings.trigger` / `settings.header` / `settings.close` (chrome content), `settings.section` (one page per feature), and `settings.onboarding` (ordered feature-owned pages in a full-viewport stage). The shell ships no copy of its own — all text arrives from registrants (ui-settings-general owns chrome, General, and the product notice; features own their sections, rows, and conditional onboarding pages). Nav labels may be locale-following thunks, so the nav projection resolves them through `resolveSlotLabel` and re-renders on the section ledger bump or the locale revision (an optional `ctx.get('locale')` read; no hard locale dependency).

The shell projects the onboarding ledger into ascending order and mounts exactly one page at a time in a body-level stage while marking the underlying app root inert. The active registrant receives its id, `complete()`, and an `openSection(id)` callback; completing or skipping transfers ownership to the next entry. Registrants own durable completion, capability readiness, copy, and mutations, so independently registered flows cannot stack and the shell does not become a second configuration fact source.

## Model Experience

None, as the settings shell serves browser UI composition; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Panel is browser-preference scope only** — host-side settings surfaces (permission mode, tool-call mode) have no RPC backing yet; their skeletons live in ui-settings-general.
