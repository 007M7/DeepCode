# @deepseek-ai/dsh-client-ui-theme

English | [中文](README.zh.md)

Theme plugin: ThemeService over the --dsw-* token base stylesheets (static scale + alias semantic layers). The service owns the theme preference (`light`/`dark`/`system`, persisted under `dsh.theme`), resolves `system` through `prefers-color-scheme`, and publishes immutable `ThemeSnapshot`s on the `theme/change` event; it never touches the DOM — ui-layout's presenter applies the resolved snapshot (`body[data-ds-dark-theme]` + inline alias tokens). Contract: api-contracts v3 §8.

## Model Experience

None, as the theme service manages a browser preference; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Third-party themes are a surface, not a product** — registering one means overriding same-named alias variables; no validation exists that an override set is complete.
- **The token sheets are the sole color authority** — values absent from cssdesign (for example the design's #4176E6 tab blue) are deliberately not appended; the nearest semantic token wins (arbitrated 2026-07-22).
