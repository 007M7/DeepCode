# @deepseek-ai/dsh-tool-subagent-control

English | [中文](README.zh.md)

The optional, globally named `send_message` tool: a thin adapter over `ctx.subagents.followup()`. Provider-bound `@deepseek-ai/dsh-tool-subagent` instances register distinct delegation tools per transport; this separately loaded package registers one shared follow-up tool, so multiple delegation tools never register duplicate global controls. Its presence does not determine whether a delegation tool starts continuable work.

The tool performs no lifecycle routing. It attributes every follow-up as `{ kind: 'coordinator', senderSessionId: parent.id }`; the subagent service preserves that source while deciding between live delivery to the running activation's existing Task and a fresh Task that cold-resumes the durable child. The tool forwards its execution signal, so cancellation while live delivery awaits admission cancels the shared activation and settles only after the child reaches quiescence. The tool renders which route was taken and the relevant Task id. A delivery failure becomes an errored tool result stating the message was not delivered.

## Model Experience

### Tool schema

#### What the model sees

The generated [`send_message` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-subagent-control): `subagent_id` and `message`, with delivery-or-continue semantics and the `task_output` collection path described.

#### Token effect

Fixed schema cost per parent request.

#### KV Cache effect

Prefix-stable; the schema does not change at runtime.

### Delivery result

#### What the model sees

`message delivered to running task <taskId>` when the message joined the running activation, or `message started task <taskId> continuing subagent <subagent_id>` when it started a cold-resume activation. Synchronous routing failures — an ownership conflict, a lost steering race, no live-delivery capability — are errored results whose message states the message was not delivered. An absent activation always reports `started`: lookup runs inside that Task, so an unknown, foreign, or descriptor-less child surfaces as the started Task settling `failed` (read through `task_output`), not as an errored `send_message` result.

#### Token effect

One short acknowledgement per call; the child's response enters parent history only when collected through `task_output` (the completion notice is a status line, never the response).

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **A delivered message has no independent result** — its effect is reflected in the current Task's eventual result; only a started follow-up owns a fresh Task result.
- **Delivery can lose timing races** — a message racing task settlement, cancellation, or cleanup fails explicitly rather than falling through to cold resume; the model retries after the task settles.
