# credentials/

English | [中文](README.zh.md)

The credential capability seam, as three-package shape dictates (interface / implementation / consumers):

| Package | Role |
|---|---|
| [`credentials/`](credentials/README.md) | Abstract `ctx.credentials`: branded `CredentialRef` references, per-operation `resolve`, UI-safe `describe`, fail-loud `set`/`unset`, the `credentials/updated` commit event |
| [`credentials-local/`](credentials-local/README.md) | File/environment provider: the live process environment (read-only, wins) layered over `$DSH_HOME/.env` (writable, byte-preserving line edits, hot-reloaded) |

Configuration files carry *references* to secrets (`apiKeyEnv: DEEPSEEK_API_KEY`), never the secrets: the settings document stays safe to sync and render, and rotating a value touches no configuration. The LLM adapters are the first consumers — they resolve their reference once per model request, which is what makes a key stored moments ago reach the very next request without restarting anything.

The seam shape leaves room for keyring-, helper-command-, and KMS-backed providers.
