# @deepseek-ai/dsh-client-ui-settings-general

English | [中文](README.zh.md)

Settings ownerless-copy and product-onboarding plugin: registers everything on the Settings surface that belongs to no single feature — the shell's trigger/header/close chrome content, the General section and its `settings.general.item` slot, the `settings` dictionaries, and the first ordered welcome step. Feature-owned rows (Permission, Language, Appearance), sections (Models), and conditional onboarding steps stay with their feature packages.

`src/onboarding-copy.ts` is the single editable owner of the complete notice plus `WELCOME_NOTICE_VERSION`; both supported GUI locales intentionally render the same Chinese copy. The Host half registers `ui-onboarding` in the user-settings seam; the browser compares `welcomeNoticeVersion` for exact equality and writes the current value only after Continue succeeds. The path mutation is idempotent across tabs and preserves sibling settings, while `host/settings-changed` makes an externally acknowledged notice advance without a reload. A different version deliberately presents the notice again. The welcome page preserves every authored paragraph, gives the requested clause in the final paragraph the sole emphasis, initially focuses the title, and has no close, Escape, mask-click, or secondary path. None of its copy or acknowledgement enters a Session log or model request. The notice identifies `DSH_TELEMETRY_DISABLED=1` as the telemetry opt-out.

## Model Experience

None, as the plugin renders browser settings UI; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- The General section has no built-in rows; each row appears only when its owning feature plugin is mounted.
