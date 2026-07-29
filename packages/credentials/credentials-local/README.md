# dsh-credentials-local

English | [中文](README.zh.md)

File-backed [credentials](../credentials/README.md) provider: two layers, one honest precedence.

| Layer | Source id | Writable | Wins |
|---|---|---|---|
| Live process environment | `env` | no | always |
| `$DSH_HOME/.env` document | `file` | yes (`set`/`unset`) | otherwise |

The environment wins because a launch-time override (`DEEPSEEK_API_KEY=… dsh`, CI secrets, a dev shell sourcing the repo `.env`) is operator intent for this run — and because it cannot be edited from inside, it must be *visibly* read-only: `describe()` reports `source: 'env', writable: false`, and `set`/`unset` reject instead of writing a change the reader would never see. Resolution reads `process.env` live and never writes it back.

## Config

| Field | Default | Meaning |
|---|---|---|
| `path` | `<harness home>/.env` | Credentials document location. |
| `dshHome` | `$DSH_HOME` or `~/.dsh` | Harness home used when `path` is omitted. |
| `watch` | `true` | Hot-publish external edits. |
| `debounceMs` | `100` | Watcher write-settle window. |

## The document

dotenv format, parsed with `dotenv` and edited by a line editor that preserves every byte it does not own: `set` rewrites the first assignment of its key in place (dropping later duplicates, which dotenv's last-wins reading would otherwise let override the edit), `unset` removes only the owning line, comments and unrelated lines survive verbatim. Writes go through [`dsh-atomic-write`](../../util/atomic-write/README.md) with mode `0600`.

Values are rendered in the narrowest style dotenv reads back verbatim — bare, then single-quoted (fully literal), then double-quoted (only without backslashes, which double-quote reading expands). A value no style can represent, and any entry that already spans multiple physical lines, fails loud instead of being corrupted silently. An empty stored value is absent, per the seam rule.

## Hot reload

External edits publish `credentials/updated` per changed reference after the snapshot is replaced **wholesale** — an entry deleted on disk never lingers in memory. The provider's own writes are recognized by content and publish exactly their one commit event. An unreadable document at runtime keeps the last good snapshot and warns; an absent file is an empty store; an unreadable file at boot fails loud. Keys that are not POSIX identifiers are preserved file content the seam cannot address.

## Model Experience

Indirectly: resolved values authorize LLM adapter requests; the consuming adapter owns every model-visible surface.

#### KV Cache effect

No direct invalidation; credentials never enter a request prefix.

## Known Limitations and Deferred Work

- **Multi-line entries refuse `set`/`unset`** — the line editor will not rewrite an entry it would corrupt; edit the file directly.
- **Unrepresentable values fail loud** — control characters, or a mix of both quote styles with backslashes, cannot round-trip the dotenv line format.
- **Environment changes are invisible** — `process.env` is read live per resolution, but no event can announce a change there.
- **Atomic, not crash-durable** — inherited from `dsh-atomic-write`; the store re-reads on boot.
