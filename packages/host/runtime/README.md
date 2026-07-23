# @deepseek-ai/dsh-host-runtime

Host runtime assembly for `dsh`: `bootHost` composes the core plugin spine (LLM service + DeepSeek adapter, sessions with JSONL persistence and immediate fallback titles, optional first-message model summaries, system prompt, tools, agents, agent loop, workspace instructions, local bash, and the provider-neutral user-interaction service), `createApiProxy` implements the [`dsh-host-apiproxy`](../apiproxy/README.md) contract over that composition, and `startHost` is the one-step shell seam returning `{ api, handler, defaults, ctx, dispose }`.

Which plugins mount and with what defaults is decided only here — shells must not `ctx.plugin` to alter the assembly. `RunningHost.ctx` is a formal seam with exactly two sanctioned uses: mounting protocol front-door plugins (e.g. a future `dsh acp`) and headless session-event subscription; consuming clients must not bypass `api` through it.

## Configuration

| Key | Default | Contract |
|---|---:|---|
| `persistenceRoot` | (required) | Root directory for JSONL session persistence. |
| `workspaceContext` | (required) | [`AGENTS.md`/`CLAUDE.md` loader](../../context/workspace-context/README.md) config with an explicit `maxBytes`, or `false` to disable it. |
| `provider` | `'deepseek'` | Default provider route injected as agentOptions on create/resume and reported by `host.describe`. |
| `model` | `'deepseek-v4-flash'` | Default model id, same single source as `provider`. |
| `cwd` | `process.cwd()` | Default project directory for a session whose create request omits `cwd`. |
| `sessionTitle` | 5 words / 40 fallback bytes / 80 accepted bytes | Deterministic fallback and accepted-title limits. |
| `sessionTitleLlm` | disabled | `true` enables the 5-word / 10-CJK-character, 4,096-input-byte, 64-output-token, 60-second first-message policy; an explicit config overrides it. An omitted route inherits the logged main-request provider and model. |

## ApiProxy implementation notes

Unary methods take the narrow `RpcRequest<P>` and echo `request.rpcId`; a prompt's rpcId rides `MessageSource` into the `user/message` event so clients can promote optimistic echoes. `history`/`prompt` on a cold session implicitly resume it, deduplicating concurrent calls through an in-flight table; `history` paginates backwards on message boundaries (never mid-message). The mux stream replays a `session/subscribed` baseline per attached session and every still-pending question with its original rpcId. Question responses, including blank per-item answers, are validated against the owning session and exact request before an atomic first-wins claim; answer, whole-request cancellation, owner abort, and provider disposal broadcast `question/resolved`. The host stream carries session lifecycle, running flips, and `agent/error` as the only outlet for live failures with no turn position.

## Model Experience

Indirectly, through the non-blocking first-message title request owned by [`dsh-session-title-llm`](../../session-title/session-title-llm/README.md) when `sessionTitleLlm` is enabled, the provider/model defaults injected into created and resumed agents, the other model-facing plugins `bootHost` mounts, and the logged [workspace-instruction prefix](../../context/workspace-context/README.md#prompt-shape) when `workspaceContext` is enabled.

#### KV Cache effect

No main-request invalidation; when enabled, the auxiliary title request has its own cache behavior and leaves the conversation prefix unchanged.

## Known Limitations and Deferred Work

- **Question waits are process-memory state** — browser reconnects recover them, but a host process restart aborts the owning tool call instead of restoring the wait from persistence.
- **`host.describe.version` is a placeholder** — it does not yet report the `apps/cli` package version.
- **The assembly is fixed** — per-deployment plugin selection (user profile, log sinks, alternative persistence) has a documented home here but no configuration surface yet.
