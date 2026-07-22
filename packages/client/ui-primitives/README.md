# @deepseek-ai/dsh-client-ui-primitives

Pure React atoms (zero cordis): StateDot, ic_ds_* icons, Button/Pill/Menu/Input, markdown family (MessageText/JsonBlock). Contract: api-contracts v3 §8.

## Model Experience

None, as the package renders pure React atoms in the browser; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Glyph-level icons are redrawn approximations** — the fish logo (and the sparkle held by ui-conversation) come from font glyphs whose vector geometry is not exportable from the local design data; hand-authored recreations stand in until an exact export path exists.
- **Pill and Input have no design source** — both atoms are self-defined; the sidebar search field and view-tab strip that resemble them are consumer-owned compositions, not these atoms.
- **StateDot `Active` variant is a hidden placeholder in the design** — not implemented; the four shipped states (done/warning/ongoing/error) are the complete P-I surface.
- **MessageText renders plain text** — markdown support swaps this component's internals later; consumers must not assume block structure.
