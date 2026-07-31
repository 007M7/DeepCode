# Agent Note: Web UI drops steer entry and interjection chrome

Status: implemented

English | [中文](2026-07-31-web-ui-no-steer-entry-or-interjection-chrome.zh.md)

## Problem

Mid-turn steering is a host/agent-loop capability (`mode:'steer'`, durable `steering/message`). The Web product already locked the composer while a turn runs and never shipped a queue/steer menu, yet the client still threaded `'queue' | 'steer'` through the input machine, `conversation.send`, and locale keys, and rendered consumed steering as a badged 「插话」/「Interjection」 bubble. That left a half-built UI surface: an unused submit mode, a product label for a gesture users cannot perform, and e2e goldens that pinned chrome the product does not own.

## Decision

Keep host and runtime steering intact. Remove only the Web UI entry and chrome:

- `InputMachine` / `SessionInput` / `InputActions.submit` / hub `defaultSink` are queue-only; they always call `session.prompt(..., 'queue')`.
- `ConversationService.send(text)` drops its mode argument and always queues.
- `MessageItem`'s `steering` arm still folds durable `steering/message` content into a plain right-aligned bubble (no badge, no user IconActions) so external/host steers stay visible on replay.
- Delete `message.steering` locale strings and the unused badge CSS.
- The web steering e2e still POSTs `mode:'steer'` over `/api/session.prompt` and asserts durable + model-visible obedience; it no longer expects interjection chrome. Update [web input machine note](../architecture/2026-07-25-web-input-machine-and-slash-pipeline.md) fact lines to match.

## Alternatives considered

**Delete host steering entirely.** Out of scope; the user asked only for Web UI display and entry. Agent-loop drain, session events, and the wire mode remain load-bearing for ACP/TUI/automation.

**Hide `steering/message` from the transcript.** Would lie on replay when an external client steers; rejected in favor of a plain bubble.

**Keep the mode parameter but only ever pass `'queue'`.** Leaves dead API surface and tests that invent `'steer'` paths the composer cannot reach.

## Consequences

- Web users cannot steer from the composer or `ctx.conversation.send`; stop/cancel and Queue remain the only mid-turn controls.
- Host-wire and non-Web clients can still steer; the Web client shows those messages without labeling them as interjections.
- Reintroducing a dedicated steer UI would need a new product decision; do not revive the mode union or badge without one.

## Testing

- `packages/client/ui-conversation` unit/jsdom coverage: input machine enter/sink, ConversationService routing, MessageItem steering arm (no 「插话」), InputBar submit.
- `apps/web/tests/steering.e2e.ts` keyless replay plus updated `settled.expected.md` (steer text without badge).
