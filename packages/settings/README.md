# settings/ — user-settings capability family

English | [中文](README.zh.md)

The user-settings seam and its providers. The interface package owns the abstract `Settings` service — namespace registration, layered resolution, and change commits; providers implement raw-document storage and push external edits through the seam. All **product** packages.

| Package | Role | ctx key |
|---|---|---|
| `settings/` | Settings seam: namespace registry, layered resolution, commit events | `ctx.settings` |
| `settings-local/` | File-backed provider (`settings.yaml`/`.json`) with hot reload and comment-preserving write-back | (registers `ctx.settings`) |

The interface lives at `settings/settings/`; providers are flat siblings. A network configuration-center provider (for example a nacos-style backend) joins here and registers on `ctx.settings`. Composition config stays in `cordis.yml`: a settings namespace carries only the user-editable subset, resolved as schema defaults, then the registrant's composition `base`, then the user document.
