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
