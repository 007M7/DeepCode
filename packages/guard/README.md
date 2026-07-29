# guard/ — loop-hygiene guard family

English | [中文](README.zh.md)

Behavioral guard plugins watch the agent loop for unproductive patterns and enforce per-call budgets. A guard is a self-contained consumer of core seams, not a swappable capability.

| Package | Role | ctx key |
|---|---|---|
| [`repeat-tool-guard/`](repeat-tool-guard/README.md) | Advisory reminders for repeated tool calls | listens on tool and agent events |
| [`timeout-policy/`](timeout-policy/README.md) | Arms per-call tool deadlines as deployment policy | registers a `tools/execute` listener |
