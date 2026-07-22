# @deepseek-ai/dsh-client-ui-theme

Theme plugin: ThemeService over the --dsw-* token base stylesheets (static scale + alias semantic layers); apply(id) toggles the `body[data-ds-dark-theme]` attribute, so theme switches are pure CSS cascade. Contract: api-contracts v3 §8.

## Model Experience

None, as the theme service toggles browser CSS; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No theme-switch control ships in P-I** — the service surface (register/apply/current) is complete but no UI owner mounts a toggle; switching happens programmatically.
- **Third-party themes are a surface, not a product** — registering one means overriding same-named alias variables; no validation exists that an override set is complete.
- **The token sheets are the sole color authority** — values absent from cssdesign (for example the design's #4176E6 tab blue) are deliberately not appended; the nearest semantic token wins (arbitrated 2026-07-22).
