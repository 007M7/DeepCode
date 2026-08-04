# dsh-credentials-local

English | [中文](README.zh.md)

File-backed [credentials](../credentials/README.md) provider: two layers, one honest precedence.

| Layer | Source id | Writable | Wins |
|---|---|---|---|
| Live process environment | `env` | no | always |
| `$DSH_HOME/.credentials.yaml` document | `file` | yes (`set`/`unset`) | otherwise |

The environment wins because a launch-time override (`DEEPSEEK_API_KEY=… dsh`, CI secrets, a dev shell sourcing the repo `.env`) is operator intent for this run — and because it cannot be edited from inside, it must be *visibly* read-only: `describe()` reports `source: 'env', writable: false`, and `set`/`unset` reject instead of writing a change the reader would never see. Resolution reads `process.env` live and never writes it back.

## Config

| Field | Default | Meaning |
|---|---|---|
| `path` | `<harness home>/.credentials.yaml` | Credentials document location. |
| `dshHome` | `$DSH_HOME` or `~/.dsh` | Harness home used when `path` is omitted. |
| `watch` | `true` | Hot-publish external edits. |
| `debounceMs` | `100` | Watcher write-settle window. |

## The document

A YAML mapping of credential reference to value, and nothing else:

```yaml
DEEPSEEK_API_KEY: sk-…
OPENAI_API_KEY: sk-…
```

The document holds credentials only, so every deviation is a rejection rather than a skipped entry — a silently ignored key would read as "the secret I stored has no effect". A non-mapping root, a key that is not a POSIX identifier, a non-string value, an empty string, a duplicate key, and malformed YAML all fail: loud at boot, and warn-and-keep-the-last-good-snapshot on a live reload. There is no `version` field and no wrapper level; the format is the mapping.

Writes patch the parsed document rather than rebuilding it, so comments and the formatting of every untouched entry survive. A comment directly above an entry is that entry's annotation and is removed with it. Every write first re-reads the document under the cross-process writer lock of [`dsh-atomic-write`](../../util/atomic-write/README.md) and publishes anything it had not observed, then commits atomically with mode `0600` under an owner-only (`0700`) directory — so a concurrent writer or an external edit inside the watcher's debounce window is folded in rather than overwritten. An on-disk document that no longer parses fails the write instead of overwriting content the provider could not understand.

Any string value round-trips, multi-line values included, so no entry is unwritable for want of a quoting style. An empty stored value is absent, per the seam rule — which is why an empty string in the document is rejected outright: `unset` removes a key, it does not blank it.

## Hot reload

External edits publish `credentials/updated` per changed reference after the snapshot is replaced **wholesale** — an entry deleted on disk never lingers in memory. The provider's own writes are recognized by content and publish exactly their one commit event. An unreadable or invalid document at runtime keeps the last good snapshot and warns; an absent file is an empty store; an unreadable or invalid file at boot fails loud.

## Security boundary

The document is `0600` under a `0700` directory, which stops other OS users — **not** the model. Tool processes (bash, the filesystem tools) run as the same user, and the shipped `workspace-write` file policy confines mutations rather than reads, so they can read this file exactly like any other file the user owns; no sandbox mode singles it out. What the harness does hold to is narrower: it never hands the model a resolved path to the document, and never loads it into the process environment — unlike `$DSH_HOME/.env`, which is the user's ordinary environment layer (see [app-boot's Personal config](../../ui/app-boot/README.md#personal-config)) — so reaching the value takes a deliberate read of a path the agent was not given.

That is discretion, not a boundary. A deployment that must keep provider keys away from its own agent cannot get there with file permissions; an OS-keychain provider — a store the model's processes cannot read at all — is the deferred answer and belongs beside this provider as a sibling package.

## Model Experience

Indirectly, through the consuming LLM adapters: stored values authorize their provider requests, and the adapter owns every model-visible surface.

#### KV Cache effect

No direct invalidation; credentials never enter a request prefix.

## Known Limitations and Deferred Work

- **Multi-line entries refuse `set`/`unset`** — the line editor will not rewrite an entry it would corrupt; `describe` reports them `writable: false` and edits must go to the file directly.
- **Same-reference concurrent writes are last-write-wins** — the writer lock and the read-modify-write keep concurrent writers from dropping each other's entries, but two writers editing one reference still resolve to the later write; there is no revision check.
- **A same-UID process can read the document** — see [Security boundary](#security-boundary): the file-effect sandbox modes do not deny reads, and an OS-keychain provider is deferred.
- **Unrepresentable values fail loud** — control characters, or a mix of both quote styles with backslashes, cannot round-trip the dotenv line format.
- **Environment changes are invisible** — `process.env` is read live per resolution, but no event can announce a change there.
- **Atomic, not crash-durable** — inherited from `dsh-atomic-write`; the store re-reads on boot.
