# RFC: Persist assembled assistant messages, not stream chunks

Status: proposed

## Problem

The canonical session log currently persists every `assistant/chunk` exactly as streamed by the model. The persistence RFC chose this for token-level replay fidelity and contiguous `seq`, but the cost has grown: JSONL fixtures are dominated by tiny delta records, snapshot scenarios replay the model by grouping chunk events, ACP load reconstructs prior assistant output from chunks, and any future log reader must distinguish durable message history from token-level trace.

The loop already appends an assembled `assistant/message` for each step. That is the event `deriveMessages()` uses for the next model request. In other words, the resumable conversation state is already present without the chunks; chunks are a live rendering and deterministic-test artifact, not required conversation history.

## Proposal

Stop storing `assistant/chunk` in the canonical session log. The durable log keeps `assistant/message`, `tool/call`, `tool/result`, `usage` if retained, and turn boundaries. Live UIs can still receive token deltas through a deliberately transient stream event. Snapshot replay should move its model script into an explicit fixture sidecar or derive it from a recorded adapter artifact, rather than treating the canonical user session as a token tape.

ACP `session/load` can replay prior assistant messages as complete content blocks instead of simulating the original token stream. A loaded transcript need not reproduce every historical delta; it must show the same completed assistant content and resume with a valid provider history.

## Acceptance criteria

- `SessionEventMap` drops `assistant/chunk`, or marks it as non-persisted if a transitional live event is needed.
- Persistence docs no longer require every stream chunk to be stored verbatim.
- `llm-replay` and ACP snapshots use an explicit replay fixture format or sidecar for model chunks.
- `session/load` renders completed assistant messages from `assistant/message`.
- Stored logs get much smaller and remain `seq`-contiguous without chunk holes.

## What we give up

The canonical user session no longer reconstructs the exact token stream of an old turn. That is acceptable for resume and load, where completed message content is the user-visible state. Tests that need exact deterministic streams should own that fixture directly instead of smuggling it through the durable session format.

## Related

This supersedes the chunk-persistence choice in [session persistence](../implemented/2026-06-14-session-persistence.md) and affects [ACP snapshot tests](../implemented/2026-06-19-acp-snapshot-tests.md), whose current replay plugin derives its script from `assistant/chunk` events.
