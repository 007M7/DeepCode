# Run the minimal agent with the Python SDK

English | [中文](python-sdk-minimal.zh.md)

This tutorial runs the minimal agent without the Web UI. The checked-in Cordis composition fixes the system prompt, tool catalog, persistent-shell behavior, and compaction policy so SDK runs use the same model-facing contract as the Web `minimal` preset.

## Prerequisites

- Python 3.10 or newer
- Linux x64, Linux arm64, or macOS arm64
- A DeepSeek-compatible API endpoint and credential
- An isolated workspace that the agent may modify

Create a virtual environment and install the SDK with its same-version bundled runtime:

```sh
python -m venv .venv
. .venv/bin/activate
python -m pip install deepseek-harness
```

The runtime wheel contains the JSON-RPC executable and every plugin used by the complete [`minimal.cordis.yml`](../../../examples/jsonrpc-agent/minimal.cordis.yml), so an installed SDK does not need Node.js.

## Run the checked-in example

Set the credential in the environment. Set `DEEPSEEK_BASE_URL` as well when the model is served by an OpenAI-compatible proxy rather than the default DeepSeek endpoint.

```sh
export DEEPSEEK_API_KEY=sk-your-key-here
# export DEEPSEEK_BASE_URL=http://127.0.0.1:8000/v1
```

Run one task from the repository checkout:

```sh
python examples/jsonrpc-agent/minimal.py \
  --workspace /absolute/path/to/workspace \
  --session-root /absolute/path/to/trajectories \
  --session-id example-001 \
  "Inspect the repository and fix the failing tests."
```

The script prints the final assistant response. The session root receives the JSONL trajectory, including the assembled model request and every tool call.

## Use the SDK in your own program

The example is a thin wrapper around this SDK call:

```python
from pathlib import Path

from deepseek_harness import DeepSeekHarness

config = Path("examples/jsonrpc-agent/minimal.cordis.yml").resolve()
workspace = Path("/absolute/path/to/workspace").resolve()
sessions = Path("/absolute/path/to/trajectories").resolve()

with DeepSeekHarness(
    provider="deepseek-official",
    model="deepseek-v4-flash",
    max_tokens=49_152,
    cwd=str(workspace),
    session_root=str(sessions),
    cordis=str(config),
) as harness:
    result = harness.run(
        "Inspect the repository and fix the failing tests.",
        session_id="example-001",
    )

print(result.final_response)
```

`DeepSeekHarness` starts the bundled JSON-RPC runtime lazily and reuses it until the context manager exits. Reusing the same harness and session id across calls also preserves the session-owned Bash process, including its working directory, exported variables, and shell functions.

## Contract reproduced by the configuration

| Surface | Fixed value |
|---|---|
| System prompt | `You are a helpful software engineer assistant.` |
| Model-facing tools | Persistent `bash` and `str_replace_editor` only |
| Bash timeout | 300 seconds |
| Editor output limit | 16,000 characters |
| Compaction | Trigger ratio `0.8`, retain `20,480` tokens, summary cap `8,192` tokens, one retry |
| Session persistence | Uncompressed JSONL under `DSH_SESSION_ROOT` |

The configuration omits harness identity, workspace prompt text, skills, one-shot Bash, task tools, and every other model-facing plugin. Filesystem policy facts are logged as runtime user context rather than appended to the system prompt. The editor requires absolute paths as an unconditional current contract, so the obsolete `requireAbsolutePath` option is absent.

## Keep runs reproducible

For comparable trajectories, pin the Harness commit and Python package version together, retain the exact Cordis file, and record the provider, model, endpoint, `max_tokens`, task input, workspace state, and session id for every run. Start independent runs with a clean workspace and a fresh session id; reuse a session only when multi-turn state is intentional.

The composition uses `danger-full-access`. Run it only inside a disposable checkout or container: Bash and the editor can modify any path allowed to the runtime process. The persistent PTY backend requires a POSIX terminal substrate and is not a Windows agent surface.

For the complete SDK lifecycle and result contract, see the [Python SDK reference](../../../python/sdk/README.md). For Cordis composition syntax, see [Configuration](./config.md).
