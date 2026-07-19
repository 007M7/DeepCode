# `@deepseek-ai/dsh-loader-smoke`

Shared subprocess harness for tests that boot an app and `cordis.yml` through the Cordis Loader. `resolveExampleLaunch` selects local `src` mode (tsx and root tsconfig paths) or CI `lib` mode (plain Node and package exports) from an explicit mode or `DSH_EXAMPLE_MODE`.

`runLoaderSmoke` accepts bin and config paths, optional complete bin arguments, environment overrides, stdin, pre-run setup, and pre-cleanup inspection. It owns the isolated cwd, DSH homes, diagnostics, deadline, termination, EOF, and cleanup; it returns both streams after a zero exit and rejects with both streams on failure.

This is support-tier test infrastructure, not product API.

## Model Experience

None, as this test-only harness boots example processes and inspects their streams without changing an assembled model request.

## Known Limitations and Deferred Work

- **Built mode requires a prior build** — the config must also resolve every named package upward through `examples/node_modules`.
- **Captured stdout and stderr are unbounded** — a runaway child can consume memory until the deadline kills it.
- **Timeout kills only the direct child** — a process tree spawned by a faulty fixture can outlive the smoke and needs external cleanup.
