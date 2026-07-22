# {{name}}

{{description}}

Built with the DeepSeek Harness SDK using the {{model}} model.

{{#if isAcp}}
## Run as an ACP server

Run `{{packageManager}} start` and configure your ACP client to launch this project. Standard output is reserved for ACP JSON-RPC.
{{else}}
{{#if isTui}}
## Run in a terminal

Run `{{packageManager}} start` to start the interactive agent.
{{else}}
## Embed the harness

Import and call the exported `main()` from `index.ts` in your host application.
{{/if}}
{{/if}}

## Development

Install NPM dependencies with `{{packageManager}} {{installArgs}}`, then use:

- `dev`: `{{packageManager}} run dev`
- `build`: `{{packageManager}} {{buildArgs}}`
- `typecheck`: `{{packageManager}} run typecheck`
- `start`: `{{packageManager}} start`
- `config`: `{{packageManager}} run config`

Edit `cordis.yml` to change the runtime plugin tree. Add or remove builtin features with `{{packageManager}} exec dsh-sdk config`.
