# @deepseek-ai/dsh-stdio

The terminal readline front door for DeepSeek Harness agents. It reads prompts from stdin, sends or steers them through `ctx.agents`, renders the durable `session/event` transcript to stdout, and answers `ctx.userInteraction` requests in the same terminal.

This package owns the terminal channel only. It injects `agents` and `userInteraction`, then drives an agent created or resumed by app or developer code. The agent spine, agent lifecycle, console logger, and model-facing [`ask_user_question`](../tool-ask-user/README.md) tool remain separate composition entries.

## Config

| Key | Default | Meaning |
|---|---|---|
| `welcome` | `ready.` | Banner printed before the first prompt |
| `agent` | `main` | Agent id driven by stdin and observed for EOF shutdown |

The plugin seeds display labels from the live agent registry, then tracks `agent/created` and `agent/disposed` so HMR and externally managed agents render consistently. Disposal closes readline and unregisters every listener/provider through Cordis effects.

```yaml
- id: stdio
  name: '@deepseek-ai/dsh-stdio'
  config:
    welcome: 'agent REPL ready. Give it a coding task.'
    agent: main
```

## Model Experience

### Readline prompt input

**What the model sees**: Each non-empty terminal line outside an active question becomes one text block, sent with `agent.send()` while the target agent is idle and `agent.steer()` while it is running.

**Token effect**: Submitted text is retained under the agent loop's normal session-history and compaction rules. The welcome banner, `> ` prompt, rendered transcript, and `[tool call]` / `[tool result]` terminal lines add no tokens.

### Terminal user-interaction answers

**What the model sees**: When a consumer calls `ctx.userInteraction.ask()`, this provider renders the question in the terminal and returns selected option labels or `custom` text. Through `dsh-tool-ask-user`, closed stdin becomes `Error: ask_user_question cannot be answered because stdin is closed`; disposal or abort becomes `Error: ask_user_question was interrupted before the user answered`.

**Token effect**: Waiting and terminal prompts add no tokens; the resolved answer or error is model-visible only through the calling tool or plugin's result.

## Known Limitations and Deferred Work

- **One configured agent receives stdin** — the session/event renderer can print output from any session, but input lines always drive the configured `agent` id rather than routing by the visible label.
- **Terminal questions are text-only and sequential** — the provider queues asks, supports option labels plus custom text, and has no richer UI shapes such as file pickers or diff previews.
- **Closed stdin ends the terminal channel** — EOF rejects active or queued questions and exits after submitted work reaches idle; there is no reconnect path for a long-lived process.
