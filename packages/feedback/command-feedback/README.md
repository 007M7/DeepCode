# @deepseek-ai/dsh-command-feedback

English | [中文](README.zh.md)

Human-facing `/feedback` capture. The plugin registers one global command through [`ctx.commands`](../../ui/commands/README.md), so every composed command adapter discovers it; the shipped TUI executes it without a model turn.

## Command contract

| Input | Result |
|---|---|
| `/feedback <text>` | Acknowledge with `Feedback recorded.` The registry's `command/run` record carries the verbatim text. |
| `/feedback` | Return a direct usage error. Whitespace-only input is treated as empty. |

Feedback text is never parsed: no truncation, case folding, or control words. Text that looks like another command, such as `/feedback /plan felt slow`, is feedback content. Repeated commands each produce their own record; nothing is replaced or merged.

## What this plugin does and does not do

The command records a remark and does nothing else. It appends no session event of its own, starts no model work, and no plugin in this repository reads its records.

The record is the command registry's own `command/run` / `command/done` pairing, which [`dsh-commands`](../../ui/commands/README.md) appends for every dispatched command. Those appends start persistence's ordinary eager drain; neither the registry nor this command forces a `session/flush`, so the acknowledgement means the entry is in the log, not that it has already reached disk. `command/run` carries the command name, the verbatim unparsed suffix, and the invocation source; the paired `command/done` carries the outcome. Both are log-only and are absent from the ordered surface, from `deriveMessages()`, and from every model request. A rejected empty input still leaves that pairing, settled as `kind: 'error'`, so no entry can be mistaken for accepted feedback.

A dedicated `session/feedback` event was considered and rejected: it would duplicate a record the registry already writes, and a consumer can select feedback by the command name it already stores.

## Composition

The producer injects only `commands`. A custom app mounts the registry plus this plugin:

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: command-feedback
  name: '@deepseek-ai/dsh-command-feedback'
```

The TUI app mounts this command unconditionally; it has no configuration and no dependency on the persisted-goal stack. The headless CLI, ACP automation, and JSON-RPC adapters do not consume `ctx.commands`, so they do not expose it.

## Model Experience

### Human `/feedback` capture

#### What the model sees

Nothing. The slash input, the recorded text, and the acknowledgement are all absent from model requests. The registry's `command/run` and `command/done` records are log-only and carry no `surfaceOp`, so they never reach the ordered surface, `deriveMessages()`, or a system prompt. Recording feedback during a turn does not change that turn's remaining requests.

#### Token effect

Zero direct token effect. Neither an accepted entry nor a usage error adds model tokens, in the recording turn or any later one.

#### KV Cache effect

Independent of the model request path. Recording appends to the session log only, leaving an already-reusable request prefix untouched. Nothing this package contributes can invalidate cache reuse.

## Known Limitations and Deferred Work

- **Nothing consumes the recorded feedback** — capture is deliberately inert. There is no retrieval, aggregation, export, or reporting surface, and no model-facing tool reads it; a consumer is a separate package that selects `command/run` records by command name.
- **No structured fields** — an entry is one free-text string with no category, severity, or referenced-event link, so feedback cannot be filtered by subject without re-reading its text.
- **No amend or withdraw** — the session log is append-only and this package adds no tombstone, so a mistaken entry stays recorded and can only be superseded by a later one.
- **Untrimmed text in the record** — the handler trims only to validate; `command/run` stores the raw suffix, including its leading separator whitespace, so a consumer trims at read time.
- **No explicit durability barrier** — the acknowledgement follows the append, not a flush, so an entry recorded immediately before a crash can be lost with any other unflushed tail. Feedback is not worth forcing a synchronous disk write for; a consumer that needs one awaits `ctx.sessions.flush(session)`.
- **TUI only in the shipped apps** — the headless CLI, ACP automation, and JSON-RPC adapters do not mount `ctx.commands`, so `/feedback` is unavailable there.
