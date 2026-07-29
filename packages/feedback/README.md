# feedback/ — recorded human feedback

English | [中文](README.zh.md)

The feedback family lets a human record a remark about the session without acting on it. Feedback is durable session-log content, separate from the model conversation and from any policy that might later read it.

| Package | Role | ctx key |
|---|---|---|
| `command-feedback/` | Trigger-independent `feedback/record` event plus the human-facing `/feedback` producer | — |

A recorded remark is log-only: it never enters the model surface or derived history, and no shipped plugin consumes it. A future consumer reads `feedback/record` events from the session log rather than changing how they are captured.
