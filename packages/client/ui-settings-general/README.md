# @deepseek-ai/dsh-client-ui-settings-general

English | [中文](README.zh.md)

Settings ownerless-copy and product-onboarding plugin: registers everything on the Settings surface that belongs to no single feature — the shell's trigger/header/close chrome content, the General section (Permission/Tool Call skeleton rows + the `settings.general.item` slot declaration), the `settings` dictionaries, and the first ordered welcome step. Feature-owned rows (Language, Appearance), sections (Models), and conditional onboarding steps stay with their feature packages.

`src/onboarding-copy.ts` is the single editable owner of the complete Chinese and English notice plus `WELCOME_NOTICE_VERSION`. The Host half registers `ui-onboarding` in the user-settings seam; the browser compares `welcomeNoticeVersion` for exact equality and writes the current value only after Continue succeeds. The path mutation is idempotent across tabs and preserves sibling settings, while `host/settings-changed` makes an externally acknowledged notice advance without a reload. A different version deliberately presents the notice again. The welcome UI has no close, Escape, mask-click, or secondary path, and none of its copy or acknowledgement enters a Session log or model request.

## Model Experience

None, as the plugin renders browser settings UI; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Permission and Tool Call are display skeletons** — the backing host services and RPC methods do not exist yet; the controls are disabled and write nothing. When they gain real backing, each moves to its owning feature plugin per the self-registration doctrine.
