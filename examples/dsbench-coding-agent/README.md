# dsbench-coding-agent

The DSBench deployment composition for the Python SDK's bundled JSON-RPC runtime. It intentionally loads no terminal UI, console logger, approval surface, or user-interaction tool because stdout belongs to the SDK protocol and benchmark turns are unattended.

The model-facing tools are:

- `bash`, foreground only
- `read`, `write`, and `edit`
- `subagent`, using one foreground in-process spawn provider
- `todo_write`

The surrounding runtime also loads JSONL session persistence and automatic context compaction. `maxTokensAsSuccess` keeps a token-limited model turn as an accepted benchmark result while preserving its `max-tokens` reason.

## Runtime environment

| Variable | Purpose |
|---|---|
| `DEEPSEEK_API_KEY` | Credential passed to the OpenAI-compatible host endpoint |
| `DEEPSEEK_BASE_URL` | Host endpoint used by `dsh-llm-deepseek` |
| `DSH_CWD` | Benchmark workspace for bash and filesystem tools |
| `DSH_SESSION_ROOT` | JSONL trajectory directory |
| `DSH_SYSTEM_PROMPT` | DSBench-provided coding persona |

Pass the config path through the Python SDK's `cordis` option or `DSH_CORDIS_CONFIG`. The bundled executable already carries every plugin named by this file; the target machine does not need Node.js.
