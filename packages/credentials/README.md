# credentials/

English | [中文](README.zh.md)

The credential capability keeps secret values behind provider-owned references:

| Package | Role |
|---|---|
| [`credentials/`](credentials/README.md) | Abstract `ctx.credentials`: branded `CredentialRef` references and per-operation `resolve` |
| [`credentials-local/`](credentials-local/README.md) | Read-only provider: the live process environment layered over an on-demand `$DSH_HOME/.env` read |

Configuration can carry a reference such as `apiKeyEnv: DEEPSEEK_API_KEY` instead of the secret itself. LLM adapters resolve that reference for each model request, so an externally rotated environment or dotenv value reaches the next request without restarting the harness.

The seam can also support keyring-, helper-command-, and KMS-backed providers when a shipped consumer needs one.
