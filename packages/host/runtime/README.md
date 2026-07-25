# @deepseek-ai/dsh-host-runtime

Host runtime assembly for `dsh`: `bootHost` composes the core plugin spine (LLM service + DeepSeek adapter, sessions with JSONL persistence, a derived SQLite FTS session-query index, immediate fallback titles, optional first-message model summaries, system prompt, tool and agent registries, agent loop, five workspace-authorized model-facing session-query tools, workspace instructions, local bash, the generic tool-timeout and 50,000-byte spill policies, and the provider-neutral user-interaction service), and `startHost` is the one-step shell seam returning `{ api, handler, defaults, ctx, dispose }` (its `api` comes from [`dsh-host-apiproxy`](../apiproxy/README.md)'s `createApiProxy` over that composition).

Which plugins mount and with what defaults is decided only here — shells must not `ctx.plugin` to alter the assembly. `RunningHost.ctx` is a formal seam with exactly two sanctioned uses: mounting protocol front-door plugins (e.g. a future `dsh acp`) and headless session-event subscription; consuming clients must not bypass `api` through it.

## Configuration

| Key | Default | Contract |
|---|---:|---|
| `persistenceRoot` | (required) | Root directory for JSONL session logs and the derived `session-query.db` SQLite FTS index. |
| `workspaceContext` | (required) | [`AGENTS.md`/`CLAUDE.md` loader](../../context/workspace-context/README.md) config with an explicit `maxBytes`, or `false` to disable it. |
| `provider` | `'deepseek'` | Default provider route injected as agentOptions on create/resume and reported by `host.describe`. |
| `model` | `'deepseek-v4-flash'` | Default model id, same single source as `provider`. |
| `cwd` | `process.cwd()` | Default project directory for a session whose create request omits `cwd`. |
| `sessionTitle` | 5 words / 40 fallback bytes / 80 accepted bytes | Deterministic fallback and accepted-title limits. |
| `sessionTitleLlm` | disabled | `true` enables the 5-word / 10-CJK-character, 4,096-input-byte, 64-output-token, 60-second first-message policy; an explicit config overrides it. An omitted route inherits the logged main-request provider and model. |

## ApiProxy implementation notes

Unary methods take the narrow `RpcRequest<P>` and echo `request.rpcId`; a prompt's rpcId rides `MessageSource` into the `user/message` event so clients can promote optimistic echoes. `history`/`prompt` on a cold session implicitly resume it, deduplicating concurrent calls through an in-flight table; `history` paginates backwards on message boundaries (never mid-message). The mux stream replays a `session/subscribed` baseline per attached session and every still-pending question with its original rpcId. Question responses, including blank per-item answers, are validated against the owning session and exact request before an atomic first-wins claim; answer, whole-request cancellation, owner abort, and provider disposal broadcast `question/resolved`. The host stream carries session lifecycle, running flips, and `agent/error` as the only outlet for live failures with no turn position.

## Model Experience

### Prior-history system prompt

#### What the model sees

Every main host agent receives the fixed prior-history guidance below because `bootHost` always mounts the session-query tool plugin.

##### Prior-history guidance

```markdown
Use session_search to find relevant work from prior sessions, or session_event_search to search earlier events in one session. Search results are cursor-free and workspace-scoped. Follow a useful hit with session_trace, session_event_trace, or session_event_read when you need lineage, relationships, or exact data.
```

#### Token effect

One fixed concise section is present on every request; `workspaceContext: false` does not remove it.

#### KV Cache effect

The repeated prefix is stable while the fixed host assembly and guidance text are unchanged. Provider cache availability and eviction remain outside the host contract.

### Session-query tool schemas

#### What the model sees

The fixed assembly mounts the generated [`session_search`, `session_event_search`, `session_trace`, `session_event_trace`, and `session_event_read` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-session-query). The schemas expose no workspace path, provider cursor, output page, model-controlled result limit, or timeout argument.

#### Token effect

Five fixed read-only schemas are present on every main-agent request; their cost changes only if the host assembly or an agent-scoped visibility policy changes.

#### KV Cache effect

The schema prefix is stable while visibility, definitions, and order are unchanged. The host makes no claim that a provider will cache or retain that prefix.

### Session-query execution and results

#### What the model sees

Cross-session results require exact equality with the calling session's workspace, while a caller without a workspace can target only itself. `session_search` excludes the calling session, and `session_event_search` on the current session excludes the step performing the call. Both searches are cursor-free, collect at most 100 authorized results, and carry a cooperative 30-second deadline; the three trace/read tools carry caller cancellation but declare no host deadline. Results are plain text. When a final result exceeds 50,000 UTF-8 bytes, the generic spill policy attempts to retain the complete formatted text in a private session-scoped file and replace it with a bounded preview, locator, and retrieval hint; a spill failure leaves the original result visible.

#### Token effect

Call arguments and data-dependent results remain in history until compaction. Search result count is bounded; after a successful spill, only the bounded preview and retrieval notice are resent, while the complete text remains outside model context.

#### KV Cache effect

Calls and results append after the reusable request prefix. Compaction may replace earlier history; timeout or spill outcomes change only the appended result text.

### Workspace instructions

#### What the model sees

When `workspaceContext` is enabled, the model receives the logged [workspace-instruction prefix and loaded file contents](../../context/workspace-context/README.md#prompt-shape), bounded by that configuration's explicit `maxBytes`. Setting `workspaceContext: false` removes this surface.

#### Token effect

Disabled mode adds no tokens. Enabled mode adds the frozen data-dependent baseline to each request, up to the configured byte budget; later discovered, changed, or removed instructions append bounded history messages.

#### KV Cache effect

Prefix-stable within one loop instance because its baseline is frozen. A new or resumed instance recomposes the baseline, while touch-discovered changes during an instance append after the reusable prefix.

### First-message title auxiliary request

#### What the model sees

When `sessionTitleLlm` is enabled, a separate [first-message title model](../../session-title/session-title-first-message-llm/README.md) receives the shared title instruction and a JSON array containing only the first eligible human message. It uses an explicitly configured route or inherits the exact logged main-request route; this auxiliary request does not add text to the main model request or delay its response.

#### Token effect

Disabled by default, so it normally adds no model request. With `sessionTitleLlm: true`, a fresh non-fork session makes at most one automatic request capped at 4,096 input bytes and 64 output tokens; an explicit configuration supplies its own caps. The deterministic fallback remains when the auxiliary request fails.

#### KV Cache effect

The main conversation prefix is unchanged. The auxiliary request has independent, provider-specific cache behavior; the host does not promise cache reuse.

## Known Limitations and Deferred Work

- **Question waits are process-memory state** — browser reconnects recover them, but a host process restart aborts the owning tool call instead of restoring the wait from persistence.
- **`host.describe.version` is a placeholder** — it does not yet report the `apps/cli` package version.
- **The assembly is fixed** — per-deployment plugin selection (user profile, log sinks, alternative persistence) has a documented home here but no configuration surface yet.
