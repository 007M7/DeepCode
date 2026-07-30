# Third-Party Notices

DeepSeek Harness is licensed under [BSD 3-Clause](LICENSE). It depends on the third-party open-source software listed below. Each project remains under its own license; nothing in this file changes those terms.

This file lists **direct** dependencies declared by the workspace. The complete transitive closure, with exact pinned versions, is recorded in [`pnpm-lock.yaml`](pnpm-lock.yaml) and can be inspected with `pnpm licenses list`.

## Vendored source (`vendor/`)

The Cordis framework and its foundation libraries are source-vendored into this repository rather than consumed from npm. All are MIT-licensed; each directory preserves its upstream `LICENSE` file. Exact upstream commits and local modifications are recorded in [`vendor/README.md`](vendor/README.md).

| Package | Upstream | License |
| --- | --- | --- |
| `cordis` | https://github.com/cordiverse/cordis | MIT |
| `@cordisjs/plugin-loader` | https://github.com/cordiverse/cordis | MIT |
| `@cordisjs/plugin-include` | https://github.com/deepseek-harness/cordis | MIT |
| `@cordisjs/plugin-group` | https://github.com/deepseek-harness/cordis | MIT |
| `@cordisjs/plugin-timer` | https://github.com/deepseek-harness/cordis | MIT |
| `@cordisjs/plugin-hmr` | https://github.com/deepseek-harness/cordis | MIT |
| `@cordisjs/plugin-logger-console` | https://github.com/deepseek-harness/cordis | MIT |
| `cosmokit` | https://github.com/deepseek-harness/cosmokit | MIT |
| `schemastery` | https://github.com/deepseek-harness/schemastery | MIT |

## Runtime npm dependencies

Direct dependencies that ship in at least one runtime surface (CLI/TUI, Web UI, SDK runtime, or the website at serve time).

| Package | License |
| --- | --- |
| [`@agentclientprotocol/sdk`](https://github.com/agentclientprotocol/typescript-sdk) | Apache-2.0 |
| [`@babel/code-frame`](https://github.com/babel/babel) | MIT |
| [`@clack/core`](https://github.com/bombshell-dev/clack) | MIT |
| [`@clack/prompts`](https://github.com/bombshell-dev/clack) | MIT |
| [`@earendil-works/pi-ai`](https://github.com/earendil-works/pi) | MIT |
| [`@earendil-works/pi-tui`](https://github.com/earendil-works/pi) | MIT |
| [`@joplin/turndown-plugin-gfm`](https://github.com/laurent22/joplin-turndown-plugin-gfm) | MIT |
| [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) | MIT |
| [`@opentelemetry/api`](https://github.com/open-telemetry/opentelemetry-js) | Apache-2.0 |
| [`@opentelemetry/api-logs`](https://github.com/open-telemetry/opentelemetry-js) | Apache-2.0 |
| [`@opentelemetry/exporter-logs-otlp-http`](https://github.com/open-telemetry/opentelemetry-js) | Apache-2.0 |
| [`@opentelemetry/otlp-exporter-base`](https://github.com/open-telemetry/opentelemetry-js) | Apache-2.0 |
| [`@opentelemetry/resources`](https://github.com/open-telemetry/opentelemetry-js) | Apache-2.0 |
| [`@opentelemetry/sdk-logs`](https://github.com/open-telemetry/opentelemetry-js) | Apache-2.0 |
| [`@shikijs/langs`](https://github.com/shikijs/shiki) | MIT |
| [`@standard-schema/spec`](https://github.com/standard-schema/standard-schema) | MIT |
| [`@testing-library/dom`](https://github.com/testing-library/dom-testing-library) | MIT |
| [`@testing-library/react`](https://github.com/testing-library/react-testing-library) | MIT |
| [`anser`](https://github.com/IonicaBizau/anser) | MIT |
| [`chokidar`](https://github.com/paulmillr/chokidar) | MIT |
| [`clsx`](https://github.com/lukeed/clsx) | MIT |
| [`commander`](https://github.com/tj/commander.js) | MIT |
| [`diff`](https://github.com/kpdecker/jsdiff) | BSD-3-Clause |
| [`eventsource-parser`](https://github.com/rexxars/eventsource-parser) | MIT |
| [`execa`](https://github.com/sindresorhus/execa) | MIT |
| [`handlebars`](https://github.com/handlebars-lang/handlebars.js) | MIT |
| [`immer`](https://github.com/immerjs/immer) | MIT |
| [`js-yaml`](https://github.com/nodeca/js-yaml) | MIT |
| [`jsonc-parser`](https://github.com/microsoft/node-jsonc-parser) | MIT |
| [`koffi`](https://github.com/Koromix/koffi) | MIT |
| [`mdast-util-from-markdown`](https://github.com/syntax-tree/mdast-util-from-markdown) | MIT |
| [`mdast-util-gfm`](https://github.com/syntax-tree/mdast-util-gfm) | MIT |
| [`micromark-extension-gfm`](https://github.com/micromark/micromark-extension-gfm) | MIT |
| [`node-addon-require-builtin`](https://www.npmjs.com/package/node-addon-require-builtin) | MIT |
| [`node-pty`](https://github.com/microsoft/node-pty) | MIT |
| [`picomatch`](https://github.com/micromatch/picomatch) | MIT |
| [`react`](https://github.com/facebook/react) | MIT |
| [`react-dom`](https://github.com/facebook/react) | MIT |
| [`react-markdown`](https://github.com/remarkjs/react-markdown) | MIT |
| [`remark-gfm`](https://github.com/remarkjs/remark-gfm) | MIT |
| [`saxes`](https://github.com/lddubeau/saxes) | ISC |
| [`shiki`](https://github.com/shikijs/shiki) | MIT |
| [`supports-color`](https://github.com/chalk/supports-color) | MIT |
| [`tsx`](https://github.com/privatenumber/tsx) | MIT |
| [`turndown`](https://github.com/mixmark-io/turndown) | MIT |
| [`typescript`](https://github.com/microsoft/TypeScript) | Apache-2.0 |
| [`use-sync-external-store`](https://github.com/facebook/react) | MIT |
| [`vitest`](https://github.com/vitest-dev/vitest) | MIT |
| [`yaml`](https://github.com/eemeli/yaml) | ISC |
| [`zod`](https://github.com/colinhacks/zod) | MIT |
| [`zustand`](https://github.com/pmndrs/zustand) | MIT |

## Development-only npm dependencies

Direct dependencies used for building, linting, testing, and generating the documentation site. They are not part of any shipped runtime artifact.

| Package | License |
| --- | --- |
| [`@braintree/sanitize-url`](https://github.com/braintree/sanitize-url) | MIT |
| [`@modelcontextprotocol/server-everything`](https://github.com/modelcontextprotocol/servers) | MIT / Apache-2.0 |
| [`@modelcontextprotocol/server-filesystem`](https://github.com/modelcontextprotocol/servers) | MIT / Apache-2.0 |
| [`@stylistic/eslint-plugin`](https://github.com/eslint-stylistic/eslint-stylistic) | MIT |
| [`@types/*`](https://github.com/DefinitelyTyped/DefinitelyTyped) (babel__code-frame, js-yaml, jsdom, mdast, node, picomatch, react, react-dom, turndown) | MIT |
| [`@typescript-eslint/parser`](https://github.com/typescript-eslint/typescript-eslint) | MIT |
| [`@vitejs/plugin-react`](https://github.com/vitejs/vite-plugin-react) | MIT |
| [`@vitest/coverage-v8`](https://github.com/vitest-dev/vitest) | MIT |
| [`@xterm/headless`](https://github.com/xtermjs/xterm.js) | MIT |
| [`@yarnpkg/cli-dist`](https://github.com/yarnpkg/berry) | BSD-2-Clause |
| [`cytoscape`](https://github.com/cytoscape/cytoscape.js) | MIT |
| [`cytoscape-cose-bilkent`](https://github.com/cytoscape/cytoscape.js-cose-bilkent) | MIT |
| [`dayjs`](https://github.com/iamkun/dayjs) | MIT |
| [`debug`](https://github.com/debug-js/debug) | MIT |
| [`esbuild`](https://github.com/evanw/esbuild) | MIT |
| [`eslint`](https://github.com/eslint/eslint) | MIT |
| [`eslint-plugin-sonarjs`](https://github.com/SonarSource/SonarJS) | LGPL-3.0-only |
| [`fast-check`](https://github.com/dubzzz/fast-check) | MIT |
| [`jscpd`](https://github.com/kucherenko/jscpd) | MIT |
| [`jsdom`](https://github.com/jsdom/jsdom) | MIT |
| [`knip`](https://github.com/webpro-nl/knip) | ISC |
| [`lefthook`](https://github.com/evilmartians/lefthook) | MIT |
| [`lightningcss`](https://github.com/parcel-bundler/lightningcss) | MPL-2.0 |
| [`mermaid`](https://github.com/mermaid-js/mermaid) | MIT |
| [`oxlint`](https://github.com/oxc-project/oxc) | MIT |
| [`oxlint-tsgolint`](https://github.com/oxc-project/tsgolint) | MIT |
| [`playwright`](https://github.com/microsoft/playwright) | Apache-2.0 |
| [`publint`](https://github.com/publint/publint) | MIT |
| [`tsdown`](https://github.com/rolldown/tsdown) | MIT |
| [`typescript-language-server`](https://github.com/typescript-language-server/typescript-language-server) | Apache-2.0 |
| [`vite`](https://github.com/vitejs/vite) | MIT |
| [`vite-tsconfig-paths`](https://github.com/aleclarson/vite-tsconfig-paths) | MIT |
| [`vitepress`](https://github.com/vuejs/vitepress) | MIT |
| [`vitepress-plugin-mermaid`](https://github.com/emersonbottero/vitepress-plugin-mermaid) | MIT |

`eslint-plugin-sonarjs` (LGPL-3.0-only) and `lightningcss` (MPL-2.0) run only as development tooling; their code is not linked into or distributed with any DeepSeek Harness artifact.

## Python SDK dependencies (`python/`)

| Package | License | Role |
| --- | --- | --- |
| [`pydantic`](https://github.com/pydantic/pydantic) | MIT | runtime dependency of `deepseek-harness` |
| [`hatchling`](https://github.com/pypa/hatch) | MIT | build backend |
| [`pytest`](https://github.com/pytest-dev/pytest) | MIT | test-only |
| [`uv`](https://github.com/astral-sh/uv) | MIT / Apache-2.0 | development workflow tool |

## Fetched at build time

| Package | License | Role |
| --- | --- | --- |
| [`@yao-pkg/pkg`](https://github.com/yao-pkg/pkg) | MIT | invoked by `scripts/build-exe-for-python-sdk.ts` to assemble the single-file SDK runtime executable |

## First-party sibling releases

`node-addon-landlock-run` (and its platform packages) is released from a DeepSeek Harness sibling repository under BSD 3-Clause. It is listed here for completeness; it is first-party, not third-party.
