# @deepseek-ai/dsh-home

`@deepseek-ai/dsh-home` is the single owner of DeepSeek Harness home-directory resolution. `resolveDshHome(configured?)` returns an absolute path using this precedence:

1. The explicit `configured` path.
2. The `DSH_HOME` environment variable.
3. The `.dsh` directory under the current user's home directory.

The resolver reads its inputs at call time. It does not cache a result, create the directory, or mutate `process.env`; consumers keep ownership of their own configuration fields and pass the configured value when resolving the shared home.

## Model Experience

Indirectly, through `dsh-tool-bash`, which exposes the resolved path to model bash as `DSH_HOME` without adding a prompt section.

## Known Limitations and Deferred Work

- **Resolution only** — the resolver makes a path absolute but does not create it, check access, or canonicalize symlinks; each consumer owns those filesystem decisions.
