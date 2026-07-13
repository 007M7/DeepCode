# `@deepseek-ai/dsh-loader-smoke`

Shared subprocess harness for keyless example smokes that boot the real stdio-agent bin and a real `cordis.yml` through the Cordis Loader. A test supplies absolute bin/config/tsconfig paths, optional environment overrides, and stdin lines; `runLoaderSmoke` owns the isolated cwd, DSH homes, tsx path resolution, 30-second process deadline, captured diagnostics, forced kill, EOF, and cleanup.

Successful runs return stdout and stderr only after a zero exit. Non-zero exits and deadlines reject with both captured streams. `LOADER_SMOKE_TEST_TIMEOUT_MS` leaves Vitest enough room for the process-owned diagnostic timeout to fire first.

This is support-tier test infrastructure, not product API. The consumers are the Loader-path smokes under `examples/{echo-agent,coding-agent,cordis-agent}`.
