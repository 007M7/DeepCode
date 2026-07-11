# DeepSeek Harness Python SDK

English | [中文](README.zh.md)

Python subprocess SDK for driving DeepSeek Harness over JSON-RPC stdio. The
runtime inherits normal DeepSeek Harness environment variables such as
`DEEPSEEK_BASE_URL` and `DEEPSEEK_API_KEY`, so callers can use real model
endpoints directly or point those variables at a local proxy during
benchmark runs.

By default, the SDK launches the bundled single-file `dsh-jsonrpc-agent` executable from the `deepseek-harness-runtime-bin` package and injects that package's default configuration (the stdio JSON-RPC server, agent core, preloaded DeepSeek adapter, JSONL session persistence, local bash) via `DSH_CORDIS_CONFIG`. To run a plugin composition of your own, keep the `@deepseek-ai/dsh-jsonrpc` entry in the config and pass the Cordis config path.

```py
from deepseek_harness import DeepSeekHarness

with DeepSeekHarness(
    model="deepseek-v4-flash",
    cordis="examples/dsbench-coding-agent/cordis.yml",
) as harness:
    result = harness.run("Make the requested code change.")
```

`TurnResult.final_response` is the text content from the last
`assistant/message` event in the turn. Use `TurnResult.events` for the complete
event stream, including intermediate assistant messages and tool activity.

The same behavior can be selected for the runtime subprocess with `DSH_CORDIS_CONFIG`. The injection lives in `HarnessClient.start()`, so the low-level client's default launch gets it too: when the launch resolves to the bundled runtime and neither `cordis` nor a non-empty `DSH_CORDIS_CONFIG` is set (the runtime treats an empty value as absent, and so does the injection check), the bundled default configuration is used; an explicit `runtime_bin` or `launch_args_override` disables the injection entirely. See the [sdk-runtime README](../sdk-runtime/README.md) for the runtime carriers (production exe vs dev-only node closure) and how to obtain them.
