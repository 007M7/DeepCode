# @deepseek-ai/dsh-host-runtime

Host runtime assembly for `dsc`: `bootHost` composes the core plugin spine (LLM service + DeepSeek adapter, sessions with JSONL persistence, system prompt, tools, agents, agent loop, local bash), `createApiProxy` implements the [`dsh-host-apiproxy`](../apiproxy/README.md) contract over that composition, and `startHost` is the one-step shell seam returning `{ api, handler, defaults, ctx, dispose }`.

Which plugins mount and with what defaults is decided only here — shells must not `ctx.plugin` to alter the assembly. `RunningHost.ctx` is a formal seam with exactly two sanctioned uses: mounting protocol front-door plugins (e.g. a future `dsh acp`) and headless session-event subscription; consuming clients must not bypass `api` through it.

## Configuration

| Key | Default | Contract |
|---|---:|---|
| `persistenceRoot` | (required) | Root directory for JSONL session persistence. |
| `provider` | `'deepseek'` | Default provider route injected as agentOptions on create/resume and reported by `host.describe`. |
| `model` | `'deepseek-v4-flash'` | Default model id, same single source as `provider`. |

## ApiProxy implementation notes

Unary methods take the narrow `RpcRequest<P>` and echo `request.rpcId`; a prompt's rpcId rides `MessageSource` into the `user/message` event so clients can promote optimistic echoes. `history`/`prompt` on a cold session implicitly resume it, deduplicating concurrent calls through an in-flight table; `history` paginates backwards on message boundaries (never mid-message). The mux stream replays a `session/subscribed` baseline per attached session on open; the host stream carries session lifecycle, running flips, and `agent/error` as the only outlet for live failures with no turn position.

## Model Experience

Indirectly, through the model-facing plugins bootHost mounts and the provider/model defaults injected into created and resumed agents.

#### KV Cache effect

No direct invalidation; the mounted model-facing plugins own their request-prefix changes.

## Known Limitations and Deferred Work

- **`respond` is a stub** — it always returns `not-pending`; the approval/question pending registry (stable-rpcId mint on accept, baseline replay on stream reopen, wire answerer) is the next host-side step.
- **`session.list` covers live sessions only** — cold sessions in the persistence directory are not yet merged into the listing; `host.describe.version` is a placeholder rather than the `apps/cli` package version.
- **The assembly is fixed** — per-deployment plugin selection (user profile, log sinks, alternative persistence) has a documented home here but no configuration surface yet.
