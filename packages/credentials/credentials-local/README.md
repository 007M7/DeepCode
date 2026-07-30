# dsh-credentials-local

English | [中文](README.zh.md)

Read-only [credentials](../credentials/README.md) provider with two externally managed sources:

| Layer | Wins |
|---|---|
| Live process environment | Always, when the named value is non-empty |
| `$DSH_HOME/.env` document | Otherwise |

The environment wins because a launch-time override (`DEEPSEEK_API_KEY=… dsh`, CI secrets, or a prepared shell) is operator intent for that process. The provider never writes either source.

## Config

| Field | Default | Meaning |
|---|---|---|
| `path` | `<harness home>/.env` | Credentials document location. |
| `dshHome` | `$DSH_HOME` or `~/.dsh` | Harness home used when `path` is omitted. |

## Resolution

Each `resolve(ref)` reads `process.env[ref]` first. If it is absent or empty, the provider reads the dotenv document and parses it with `dotenv`; a missing file, missing key, or empty value resolves to `undefined`, while any other file error rejects the operation. Nothing is watched or cached, so an external edit is visible to the next resolution without a provider lifecycle or mutation API.

The provider accepts dotenv's parsing semantics, including last-assignment precedence. It does not create the document or control its permissions; the operator or external credential-management surface owns both.

## Security boundary

The harness does not expose the resolved document path to the model or hoist the file into the process environment (see [app-boot's Personal config](../../ui/app-boot/README.md#personal-config)). This is discretion, not isolation: tools run as the same OS user and can read any file that user's permissions allow. A deployment that must keep provider keys away from its own agent needs a provider backed by a store those tool processes cannot read.

## Model Experience

Indirectly, through the consuming LLM adapters: resolved values authorize their provider requests, and the adapter owns every model-visible surface.

#### KV Cache effect

No direct invalidation; credentials never enter a request prefix.

## Known Limitations and Deferred Work

- **Mutation is external** — edit the dotenv document, launching environment, or upstream secret store; this provider intentionally has no write API.
- **Every file fallback performs I/O** — the implementation favors a small always-current read path over a watcher, cache, and invalidation lifecycle.
- **A same-UID process can read the document** — file permissions do not isolate a secret from model-invoked tools running as the same user.
