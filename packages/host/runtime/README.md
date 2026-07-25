# @deepseek-ai/dsh-host-runtime

Host runtime assembly for `dsh`: `bootHost` composes the core plugin spine (LLM service + DeepSeek adapter, sessions with JSONL persistence, a derived SQLite FTS session-query index, immediate fallback titles, optional first-message model summaries, system prompt, tool and agent registries, agent loop, workspace instructions, local bash, the generic tool-timeout and 50,000-byte spill policies, and the provider-neutral user-interaction service), and `startHost` is the one-step shell seam returning `{ api, handler, defaults, ctx, dispose }` (its `api` comes from [`dsh-host-apiproxy`](../apiproxy/README.md)'s `createApiProxy` over that composition).

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

### Optional session-query consumer

#### What the model sees

The derived `ctx.sessionQuery` index is not model-facing. `bootHost` intentionally leaves the optional [`dsh-tool-session-query`](../../session-query/tool-session-query/README.md) consumer unmounted, so main host agents receive neither its prior-history prompt section nor its five schemas by default.

#### Token effect

The index adds no prompt or schema tokens. A custom composition that mounts the consumer owns its added prompt, schemas, calls, and results.

#### KV Cache effect

The index alone does not change the reusable model-request prefix; mounting the optional consumer would add its stable prompt and schema prefix.

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
