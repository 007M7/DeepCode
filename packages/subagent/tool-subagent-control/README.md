# @deepseek-ai/dsh-tool-subagent-control

English | [中文](README.zh.md)

The optional, globally named `send_message` and `list_agents` tools are thin adapters over `ctx.subagents`. Provider-bound `@deepseek-ai/dsh-tool-subagent` instances register distinct delegation tools per transport; this separately loaded package registers shared control tools once, so multiple delegation tools never register duplicate global controls. The root plugin registers `send_message` and requires only `subagents`; the separately loadable `./list-agents` plugin registers `list_agents`, declares `sessionQuery` as a load-time dependency, and remains inactive until that service is available. A deployment without session query keeps `send_message` and omits the list tool. Neither tool's presence determines whether a delegation tool starts continuable work.

The tool performs no lifecycle routing — residency and cold resume belong to the subagent service. It passes `exec.agent` as the exact live parent that authorizes delivery and attributes every message as durable provenance `{ kind: 'coordinator', senderSessionId: parent.id }`, which the service retains but never treats as authority. Every message becomes the subagent's next FIFO turn through `Agent.followup()`: if the child is still working, the message waits until its current turn finishes, so it cannot redirect work already underway. The tool forwards its execution signal, which owns admission only until inbox acceptance; once the child accepts the message the accepted turn cannot be cancelled through this tool. The child does not reply to the sender — its transcript by that id is the source of what it did. A delivery failure becomes an errored tool result stating the message was not delivered.

`list_agents` takes no arguments, derives the parent id from the calling agent, and projects `ctx.subagents.listChildren()` to continuable children without a cursor. The service result also contains one-shot session-backed subagents for consumers such as a UI, but those entries are omitted from this model tool because they cannot accept `send_message`. Diagnostics remain visible. Durable identity and mode come from each child's descriptor, while delivery-time authority and Activation ownership checks remain `send_message`'s.

## Model Experience

### Tool schema

#### What the model sees

The generated [`send_message` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-subagent-control): `subagent_id` and `message`, describing that the message becomes the subagent's next turn, that the subagent does not reply, and that a failure means the message was not delivered.

#### Token effect

Fixed schema cost per parent request.

#### KV Cache effect

Prefix-stable; the schema does not change at runtime.

### Delivery result

#### What the model sees

`message queued as the next turn for subagent <subagent_id>` on acceptance; the canonical output carries the accepted `messageId`. A failure — an unauthorized or unknown child, a descriptor-less child that cannot be resumed, or admission rejected — is an errored result whose message states the message was not delivered.

#### Token effect

One short acknowledgement per call; the child's response never returns through this tool, so its output enters parent history only if a caller reads the child transcript and relays it.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Listing result

#### What the model sees

One line per continuable child in the trace's stable order: `<id> [<status>] — <label>` (`running` = the logical session is live, `complete` = persisted only and resumable by `send_message`), plus `<id> [diagnostic: <reason>]` for a candidate that could not be read (`corrupt`, `unsupported`, or `unavailable`). One-shot children are intentionally absent; `(no subagents)` means no continuable child or diagnostic survived the projection. Diagnostics never expose descriptor contents.

#### Token effect

Grows linearly with the parent's direct continuable children; there is no cursor or cap, so long-lived parents with many persisted children pay the full list each call.

#### KV Cache effect

Append-only; each result follows the reusable request prefix.

## Known Limitations and Deferred Work

- **A queued message has no independent result** — acceptance returns only its inbox `messageId`; the child's work on that turn lands in the durable child Session, read by its subagent id, and is neither delivered back nor collected through this tool.
- **No steering of the current turn** — every message opens a later FIFO turn, so a message sent while the child is working runs only after its current turn finishes and cannot redirect it.
- **Listing is a snapshot, not a delivery promise** — it may race publication, disposal, or a later message, and another process may activate a child this process reports as `complete`; cross-process accuracy requires a shared lease.
- **No pagination or deletion** — the complete stably ordered set is returned, and persisted children remain listed for as long as their sessions remain in persistence; a service-level bound or delete operation is a later product decision.
