# `@deepseek-ai/dsh-session-reference`

`ctx.sessionReferences` prepares bounded, read-only snapshots of other sessions as additional context. It consumes `ctx.sessionQuery` and the backend-independent compact checkpoint marker; SQLite FTS is not required. The standard TUI and ACP demo bundles mount it, while other hosts may call the service directly.

## Public API

- `listCandidates(agent, query?, limit?)` lists sessions other than `agent.id`, filters case-insensitively by id or cwd, and ranks same-cwd, cwd-less, then other-cwd records while preserving `listSessions()` creation order within each group. Each selected candidate uses its latest log-backed title as the mention label and falls back to the session id; titles and message bodies are not searched.
- `prepare(agent, content, references, signal?)` preserves first-mention order, deduplicates ids, rejects self-reference and more than the configured distinct-source limit, reads every source in parallel, and returns detached content plus zero or one aggregated `UserMessageData` context. Any invalid reference, failed read, cancellation, or budget failure rejects before the host injects context and sends or steers the direct message.
- `encodeSessionReferenceUri()` and `decodeSessionReferenceUri()` implement `dsh-session:<base64url(JSON.stringify(sessionId))>` so every JavaScript string id round-trips exactly. `formatSessionReferenceMention()` emits `@[label](uri)`, and `parseSessionReferenceText()` replaces Markdown mentions or bare canonical URIs with readable `@label` text while returning structured references. Explicit Markdown mentions reject every malformed URI; bare text is considered a reference only when a non-empty base64url-shaped payload follows the scheme, and a matching noncanonical candidate still fails. Empty or punctuation-only scheme mentions remain ordinary discussion text.

## Snapshot semantics

Preparation calls `ctx.sessionQuery.readSurface()` once per distinct source and never rereads it after delivery. It projects only direct-user `user/message`, direct-user `steering/message`, assistant text, and `user/message` checkpoints carrying the canonical `dsh-compact` source marker from the folded current surface. Synthetic context, shadowed pre-compaction events, tools, reasoning, plugin-generated user messages other than marked compact checkpoints, and unfinished assistant chunks are excluded. A compacted source therefore contributes its latest checkpoint plus retained later conversation, not restored shadowed text.

The context uses a typed `{ kind: 'session-reference', ... }` source. That source records version `1`, source ids and labels, capture seqs, compact presence, retained/omitted message counts, omitted UTF-8 bytes, and truncation state. Hosts call `inject()` with the snapshot before delivering the direct prompt, so the session log keeps two simple messages with independent provenance. TUI and ACP replay the direct user message normally and render the injected snapshot as a compact reference card. Later source mutation, compaction, or deletion cannot change target replay.

## Configuration

| Key | Default | Contract |
|---|---:|---|
| `maxReferences` | `3` | Maximum distinct source sessions in one prepared message; must be at most `3`. |
| `candidateLimit` | `50` | Default metadata candidate count returned to a host. |
| `maxReferenceBytes` | `65536` | Maximum serialized JSON bytes for one reference object. |

Retention applies `maxReferenceBytes` independently to each source, keeps compact checkpoints and the newest message before dropping older non-checkpoint units, and uses `dsh-retention` head/tail truncation with an exact UTF-8 omission notice. If one source's fixed serialized fields cannot fit, preparation fails with `SESSION_REFERENCE_BUDGET_EXCEEDED` instead of returning a partial context.

## Model Experience

### Referenced session background

#### What the model sees

The model sees two consecutive user-role messages: the `## Referenced sessions` untrusted snapshot, then the current message with its readable `@label`. The warning forbids following instructions, permission claims, or tool requests from the snapshot unless the current user repeats them. Labels, cwd values, ids, and conversation text are serialized as JSON inside `<referenced-sessions>` tags; every data `<` is emitted as the lossless JSON escape `\u003c`, so source text cannot spell a framing tag.

#### Token effect

Each referenced message adds the fixed warning plus up to three serialized snapshots, each independently bounded by `maxReferenceBytes`. The exact snapshot remains in target history until target compaction shadows or summarizes it; source-session changes add no further tokens.

#### KV Cache effect

The snapshot and request append as adjacent target messages and preserve earlier cacheable history. Different references or source capture contents change the new suffix only; later target compaction may invalidate reuse from its replacement boundary.

## Known Limitations and Deferred Work

- **No title or full-text discovery** — candidates filter by session id and cwd only, although selected rows display the latest title. SQLite FTS may replace discovery later without changing URI, snapshot, or persistence contracts.
- **Trusted caller boundary** — the service assumes its host is authorized to read every session exposed by `ctx.sessionQuery`; it is not a model-facing search tool.
- **Text projection only** — non-text user and assistant blocks are not propagated across sessions.
- **No live link** — references are snapshots, not forks, resumes, subscriptions, or source-session mutations.
