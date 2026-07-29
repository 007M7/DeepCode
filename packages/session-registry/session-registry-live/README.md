# @deepseek-ai/dsh-session-registry-live

English | [中文](README.zh.md)

Publishes every live session in this process into the [session registry](../session-registry/README.md), so `dsh list-sessions` lists the sessions a server creates on demand rather than only the one a launcher minted up front.

## Behavior

Registration follows session lifecycle rather than a launcher-known identity: the plugin publishes every session present at mount and every later `session/created`, and removes a record when its session is disposed. One path therefore serves both the TUI's single session and the browser UI's one-per-conversation sessions.

A session whose header carries no `cwd` is skipped — the listing's workspace column would have nothing truthful to show.

`session/title` events are mirrored onto the record through `retitle`, so the latest logged title reaches the listing. Carrying the title in the record is what keeps the reader backend-agnostic: the log's location, file format, and compression are per-deployment choices (the shipped TUI writes zstd-compressed JSONL), so an independent process cannot portably parse one.

Publication is fire-and-forget with a warning on failure: the registry is an observability aid, so a registry fault must not fail a working agent session. A session that ends while its registration is still in flight leaves a tombstone the completing registration observes, so its record cannot outlive the session until a pid-based prune.

## Config

None. Every published record is derived from the session itself, so no deployment-varying choice is left to configure.

## Model Experience

None, as this package registers no tools, injects no prompts, and appends no session events; it only mirrors existing lifecycle and title events into a host-side process record.

#### KV Cache effect

Independent of live requests: the plugin reads session events and writes a separate registry file without touching any request prefix, so it cannot invalidate provider cache reuse.

## Known Limitations and Deferred Work

- **A skipped session is invisible, not deferred** — a session created without a `cwd` is never published, even if a workspace becomes known later; there is no re-check.
- **Title mirroring costs one registry write per revision** — each `session/title` event triggers a locked read-modify-write, so a deployment with an aggressive retitling cadence pays that write per revision.
