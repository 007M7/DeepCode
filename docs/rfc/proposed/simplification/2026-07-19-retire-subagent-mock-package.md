# RFC: Retire the standalone subagent mock package

Status: proposed

English | [中文](2026-07-19-retire-subagent-mock-package.zh.md)

## Problem

`@deepseek-ai/dsh-subagent-mock` is a configurable test double packaged as a workspace plugin. Its only external consumers are the `tool-subagent` unit suite and the tool-catalog generator. No runtime package, example, snapshot configuration, or real provider loads it.

That narrow fixture carries a manifest, exports, peer and development dependencies, project references, package README obligations, Loader composition tests, module-graph membership, and documentation-gate exceptions. The tool-catalog generator mounts it only to make the real subagent tool register its schema; it never executes a child.

## Proposal

Delete `packages/support/subagent-mock`. Move the scripted provider behavior actually used by `tool-subagent` into a package-local test fixture while continuing to exercise the real `SubagentService`, provider registry, and tool implementation.

Have the tool-catalog generator register the minimal provider descriptor required before mounting `ToolSubagent`. Remove the package references, manifest dependency, graph node, README allowlists, and mock-specific Loader tests.

## Alternatives considered

**Keep a reusable mock package for future tests.** Reuse has not materialized outside one test file and one generator. A future second consumer can extract a fixture once its shared contract is known; packaging all configurable reply, cancellation, result, and Loader behavior today makes test infrastructure look like a supported backend.

**Generate the subagent schema without mounting the real tool.** Hand-constructing or importing the schema would weaken the catalog's check that the production registry and tool composition expose the documented shape. The generator should keep mounting the real service and tool with only the child boundary replaced.

## Acceptance criteria

- `packages/support/subagent-mock` and every workspace, graph, dependency, and documentation entry for it are removed.
- `tool-subagent` tests retain every scripted reply, structured-result, cancellation, foreground/background, and task-integration case they currently exercise through the real service and tool.
- Tool-catalog generation mounts the production subagent registry and tool with a minimal local provider and produces a byte-identical catalog.
- No runtime or example package gains a dependency on test-only fixtures.
- Focused subagent tests, catalog and graph generation, module-graph verification, build, hygiene, and the full pre-push suite pass.

## Risks

Relocating the fixture could accidentally replace too much production composition with a stub. The local fixture must implement only the nondeterministic child boundary; capability checks, lifecycle, task handling, and tool output remain under production code. Mock Loader and HMR coverage can disappear because no deployed composition consumes the package afterward.
