# RFC: Make JSON-RPC completion and transport directional

Status: proposed

English | [中文](2026-07-19-make-jsonrpc-directional.zh.md)

## Problem

The JSON-RPC bridge models both endpoints as symmetric peers although the shipped protocol is directional. The TypeScript server accepts requests and emits responses or notifications, but its transport also implements unused outbound requests and inbound notification dispatch. The Python SDK sends requests and receives responses or notifications, but it also queues unused inbound server requests and exposes response helpers.

`session/prompt` also reports one settled turn through two protocol shapes. The server emits `session.finished` and then returns the constant `{ accepted: true }`; the Python SDK discards that response and waits for the notification to recover the status. Because the response is written only after the handler returns, the notification necessarily precedes the constant response on the same stream.

The unused halves add pending-request maps, generated IDs, request queues, close-time rejection paths, response helpers, and a second completion waiter without serving a production caller.

## Proposal

Specialize each endpoint to its actual role. The TypeScript transport will retain inbound requests, outbound responses, and outbound notifications. The Python client will retain outbound requests and inbound responses or notifications. Delete the opposite-direction request machinery from each side.

Return the settled outcome directly from `session/prompt` as `{ status, reason }` after `agent.whenIdle()`. Delete `session.finished`, the constant acceptance response, and the Python post-response completion loop. `session.event` and subagent notifications still stream before the response, and durable session events remain the source for final-response reconstruction.

## Alternatives considered

**Keep a generic symmetric JSON-RPC peer for future methods.** Server-initiated requests may eventually support interactive permissions, but no typed method or production consumer exists. The pre-release protocol can add the smallest required direction when that feature is designed instead of carrying an unexercised peer today.

**Keep `session.finished` for streaming clients.** Turn settlement is not incremental data: the request response already marks the same boundary and follows all earlier notifications on the ordered stream. A second terminal notification creates two representations that clients must reconcile.

## Acceptance criteria

- The TypeScript endpoint cannot originate requests or consume notifications.
- The Python endpoint cannot originate notifications or consume server requests.
- `session/prompt` returns the authoritative `ok`, `error`, or `aborted` outcome and reason after turn settlement.
- Session events and subagent lifecycle notifications emitted during the turn arrive before the response.
- Same-session overlap rejection, framing, multibyte input, handler errors, flush, shutdown ordering, and final-response reconstruction retain their behavior.
- TypeScript bridge tests, Python SDK tests, built JSON-RPC coverage, snapshots, and generated API documentation pass.

## Risks

This deliberately narrows the pre-release wire protocol. Raw clients listening only for `session.finished`, or embedders using the unused symmetric transport methods, must move to the prompt response. A future server-initiated request requires a new typed protocol addition rather than reusing generic dormant machinery.
