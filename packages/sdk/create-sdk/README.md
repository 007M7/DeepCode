# `@deepseek-ai/create-sdk`

Interactive initializer for `npm create @deepseek-ai/sdk [directory]`. Directory/name/description have visible editable defaults. A tree picker selects features and configures finite options with Right/Left navigation; secret text follows only for selected options. Local plugin creation is one none/plugin/tool choice.

The supported package surface is the `create-sdk` bin. The package root exports no symbols, and workflow, bin, source, and package-manifest subpaths are not exported.

The initializer rejects every existing target path, creates one `SdkProject` edit session, validates and commits it, then asks whether to install NPM dependencies and build. Install or build failures keep the generated project and print a retry command.

Public flags are `[directory]`, `--description`, `--provider`, `--base-url`, `--api-key`, `--model`, `--interface`, `--pm`, and `--install`/`--no-install`. Flags prefill matching questions, but creation always requires a TTY.

The provider choice is DeepSeek or a custom endpoint backed by `llm-pi-ai`. DeepSeek asks only for an API key and uses the public endpoint plus `deepseek-v4-flash`; custom also asks for a base URL. An empty key requires confirmation and creates a commented empty `.env` variable so provider startup fails clearly until it is filled. Existing plugin defaults are omitted; required SDK presets remain typed against the owning package's Config.

## Model Experience

Indirectly, through the generated project composition and its selected runtime plugins.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **TTY-only creation** — flags prefill questions, but the wizard still requires an interactive terminal before it writes a project.
