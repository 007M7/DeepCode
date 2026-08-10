# jsonrpc-agent

English | [中文](README.zh.md)

The unattended coding-agent composition for the Python SDK's bundled JSON-RPC runtime. It intentionally loads no terminal UI, console logger, approval surface, or user-interaction tool because stdout belongs to the SDK protocol and turns are driven by the SDK.

The model-facing tools are:

- `bash`, foreground only
- `read`, `write`, and `edit`
- `subagent`, using one foreground in-process spawn provider
- `todo_write`

The surrounding runtime also loads JSONL session persistence and automatic context compaction. `maxTokensAsSuccess` keeps a token-limited model turn as an accepted evaluation result while preserving its `max-tokens` reason.

## Runtime environment

| Variable | Purpose |
|---|---|
| `DEEPSEEK_API_KEY` | Credential passed to the OpenAI-compatible host endpoint |
| `DEEPSEEK_BASE_URL` | Host endpoint used by `dsh-llm-deepseek` |
| `DSH_CWD` | Agent workspace for bash and filesystem tools |
| `DSH_MAX_TOKENS_AS_SUCCESS` | `true` (default) accepts token-limited results; `false` reports them as errors |
| `DSH_SESSION_ROOT` | JSONL session directory |
| `DSH_SYSTEM_PROMPT` | Deployment-provided coding persona |

Pass the config path through the Python SDK's `cordis` option or `DSH_CORDIS_CONFIG`. The bundled executable already carries every plugin named by this file; the target machine does not need Node.js.

## Minimal variant

[`minimal.cordis.yml`](minimal.cordis.yml) is the complete standalone counterpart of the Web `minimal` preset. It fixes the system prompt and compaction policy, and its model-facing surface is exactly:

- owner-scoped persistent `bash`
- `str_replace_editor` with `view`, `create`, `str_replace`, and `insert`

It composes the local PTY, filesystem intent policy, session sandbox policy, and JSONL persistence needed by the bundled runtime. [`minimal.py`](minimal.py) runs it through the Python SDK; the [Python SDK tutorial](../../docs/user/guide/python-sdk.md) uses this configuration to cover setup, session management, and the security boundary.
