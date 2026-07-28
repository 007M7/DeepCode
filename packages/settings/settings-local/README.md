# @deepseek-ai/dsh-settings-local

English | [中文](README.zh.md)

File-backed settings provider. One YAML or JSON document carries every namespace section; external edits hot-publish through `ctx.settings`, and `update()` writes back atomically while preserving the user's YAML comments and any section owned by a plugin that is not currently loaded.

## Config

| Field | Meaning | Default |
|---|---|---|
| `path` | Settings document path; extension picks the format (`.yaml`/`.yml`/`.json`) | `settings.yaml` under the harness home |
| `dshHome` | Harness home used when `path` is omitted | `$DSH_HOME` or `~/.dsh` |
| `watch` | Watch the document and hot-publish external edits | `true` |
| `debounceMs` | Watcher write-settle window in milliseconds | `100` |

Defaulting is one explicit `resolveSpec(config)` step; an unsupported extension fails at load.

## Behavior

- **Boot fails loud, reload keeps last-good.** An existing-but-invalid document fails plugin load; once live, an unreadable or unparsable edit warns and keeps the last good sections. A missing document resolves every namespace from defaults and `base`; deleting it publishes the same empty state.
- **Write-back is atomic, owner-only, and symlink-proof.** `persist` exclusive-creates a random-suffix temp sibling with mode `0600` (`wx` refuses to follow a planted symlink) and renames over the target, cleaning the temp up on failure. YAML writes patch one namespace in the comment-preserving document; JSON re-serializes.
- **Dispose quiesces.** Teardown stops accepting watcher events, closes the watcher, then waits out any queued or in-flight reload, so nothing publishes after disposal.
- **Self-write suppression by content.** The provider caches the last good text; a watcher event whose content equals the cache (its own write included) is a no-op.

## Model Experience

Indirectly, through consumers of `ctx.settings`: this provider only stores and publishes namespace sections, and each consumer's own surface documents any model effect.

#### KV Cache effect

No direct invalidation; the consuming plugin owns any request-prefix changes.

## Known Limitations and Deferred Work

- **No cross-process write lock** — concurrent writers (for example TUI and web on one home) converge by atomic replace plus watcher reload, last write wins; a lockfile is deferred until real contention shows up.
- **Comment preservation is YAML-only** — JSON documents re-serialize without comments (JSON has none) and lose hand formatting.
- **No value indirection** — sections hold literal values; `${env:VAR}`-style references for secrets are a deferred seam-level feature.
