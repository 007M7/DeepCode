# @deepseek-ai/dsh-tool-subagent-control

The globally named `send_message` tool: a thin adapter over `ctx.subagentControl.sendMessage()`. Provider-bound `@deepseek-ai/dsh-tool-subagent` instances register distinct delegation tools per transport; this separately loaded package registers the one shared control tool, so multiple delegation tools never register duplicate global controls.

The tool performs no lifecycle routing. The control service decides between live delivery to the running activation's existing Task and a fresh Task that cold-resumes the durable child; the tool renders which route was taken and the relevant Task id. A control-service throw becomes an errored tool result stating the message was not delivered.

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

`message delivered to running task <taskId>` when the message joined the running activation, or `message started task <taskId> continuing subagent <subagent_id>` when it cold-resumed the child. Failures are errored results whose message states the message was not delivered (unknown or foreign child, ownership conflict, settlement race, no live-delivery capability).

#### Token effect

One short acknowledgement per call; the child's response enters parent history only when collected through `task_output` or injected by the task completion notice.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **A delivered message has no independent result** — its effect is reflected in the current Task's eventual result; only a started follow-up owns a fresh Task result.
- **Delivery can lose timing races** — a message racing task settlement, cancellation, or cleanup fails explicitly rather than falling through to cold resume; the model retries after the task settles.
