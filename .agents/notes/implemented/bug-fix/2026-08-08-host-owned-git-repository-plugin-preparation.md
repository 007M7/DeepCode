# Agent Note: Host-owned preparation makes GitHub repository Plugins installable

Status: implemented

English | [中文](2026-08-08-host-owned-git-repository-plugin-preparation.zh.md)

## Problem

The repository Plugin authoring contract depended on `scripts.prepare: "dsh-plugin-prepare"` and told source repositories to add `@deepseek-ai/dsh-repository-plugin` as a development dependency. That package is private and not published to npm, so an otherwise valid external GitHub repository could not obtain the helper in a clean install.

The lifecycle choice also failed for a selectable `.dsh-plugin` inside a pnpm workspace. pnpm prepares a Git-hosted package by running the repository's preferred package manager before packing the selected subdirectory. A nested `pnpm install` joins the containing workspace and need not execute the unlisted `.dsh-plugin` package's `prepare` script. The install could therefore succeed and publish a cache generation containing only the source package metadata; real DSH startup failed later because `dsh-plugin.mjs` did not exist.

The checked-in headless fixture did not catch either defect because it mounted an already prepared wrapper. It proved runtime composition, not GitHub acquisition or package preparation.

## Decision

The authoring format requires a non-empty `scripts.prepack` that invokes `dsh-plugin-prepare` and needs no DSH dependency for that helper. The package may declare its own build and runtime dependencies and run compilation before the helper. pnpm's Git-hosted package preparation invokes `prepack` explicitly after its dependency-install step and before packlist selects the `.dsh-plugin` subtree, so the helper can validate built entries and still copy sibling repository assets such as `../skills` into the package.

`@deepseek-ai/dsh-repository-plugin` materializes short-lived POSIX and Windows command wrappers that invoke its own built `dsh-plugin-prepare` entry. `RepositoryCache` accepts caller-owned executable directories, resolves them absolutely, and prepends them to the credential-scrubbed lifecycle `PATH` passed to bundled pnpm. The command directory exists only for the installation transaction and is removed on success or failure. The repository remains trusted package-manager input: DSH supplies one command, but other lifecycle scripts and dependencies still execute under the existing trust contract.

The Node 24 consumer lane passes an exact source derived from the pull request head repository and SHA. Because that repository is private, the workflow writes a job-scoped Git configuration that uses the read-only job token for GitHub HTTPS and rewrites pnpm's SSH fallback to that authenticated transport. Its built-entry acceptance launches the real `apps/cli/lib/bin.js run` command with a one-run patch selecting a `private: true` GitHub fixture. That fixture installs pinned npm dependencies, type-checks and bundles a TypeScript Cordis entry and MCP server in `prepack`, invokes the host helper, and proves the skill, MCP call, and code entry through real model requests and immutable-cache artifacts. The test fails if CI omits the exact source instead of silently skipping.

## Alternatives considered

**Publish the prepare helper to npm.** Rejected because the source package would acquire a release/version dependency solely to call code already owned by the running DSH installation, and the existing helper is intentionally private.

**Keep `prepare` and only inject the command.** Rejected because command availability does not make a nested package's `prepare` lifecycle run when the Git repository's package manager treats it as part of another workspace.

**Prepare after RepositoryCache installs the selected package.** Rejected because pnpm's packed subdirectory no longer contains sibling source assets referenced by paths such as `../skills`; preparation must happen before packlist.

**Clone GitHub repositories in DSH and bypass pnpm's Git fetcher.** Rejected because it would duplicate ref resolution, subdirectory selection, dependency installation, packlist behavior, and cache integrity already owned by the pinned package manager.

## Consequences

- A repository author can commit the fixed `.dsh-plugin/package.json` and source assets to GitHub without publishing either the Plugin or its preparation helper to npm.
- Private GitHub sources use the host's standard Git authentication. CI proves that path with a temporary read-only configuration rather than persistent runner credentials.
- `prepack`, not `prepare`, is part of the pre-release authoring format. It may contain package-owned build steps but must invoke the host helper; missing or empty lifecycle metadata fails installed-package validation instead of producing an ambiguous partial format.
- Exact source strings still identify immutable cache generations; a changed ref or source configuration selects another generation.
- The host supplies only the preparation executable. Package dependencies, compilation, and the trusted `dsh.entry` contribution remain owned by the repository package and the [trusted-code decision](../architecture/2026-08-08-trusted-repository-package-code.md).

## Testing

`packages/ui/app-boot/tests/repository-cache.spec.ts` runs a local Git subpath through bundled pnpm with an injected command directory and proves that visible environment survives while credential-shaped variables are scrubbed. `packages/cordis/repository-plugin/tests/repository-plugin.spec.ts` pins helper-bearing `prepack` metadata and temporary command cleanup. `examples/headless-agent/tests/keyless-smoke.e2e.ts` keeps the checked-in prepared fixture on that source contract. `apps/cli/tests/github-repository-plugin.built.e2e.ts` is the product acceptance: fresh DSH home, exact authenticated private GitHub source, actual built `dsh run`, package-owned TypeScript build, real MCP execution, code-entry transformation, mock LLM request observation, and prepared cache inspection.
