# Agent Note: Bundled dsh badge skill

Status: implemented

English | [中文](2026-08-06-bundled-dsh-badge-skill.zh.md)

## Problem

DeepSeek Harness has an official attribution badge skill, but keeping it only in a developer's personal skill directory makes it unavailable to other DSH installations and gives the shipped application no explicit opt-in point.

## Decision

`@deepseek-ai/dsh-skill-badge` is a native Cordis plugin that registers one immutable bundled provider on `ctx.skills`. The provider owns the `dsh-badge` summary, instruction body, and PNG resource base; `dsh-tool-skill` remains the sole owner of model-facing catalog and loader rendering.

The shipped CLI composition declares `skill-badge` as disabled. Enabling that existing row is the explicit opt-in; disabled installations advertise no badge skill and gain no model-visible content.

The provider uses the bundled rank after project, custom, and user filesystem sources, so a user-owned `dsh-badge` definition can override it through the ordinary registry precedence contract. Provider disposal removes the contribution through the registry-owned effect.

## Alternatives considered

A Codex marketplace plugin was rejected because it would install into a different runtime and would not participate in DSH's `ctx.skills` seam. Mounting `dsh-skill-local` over the packaged files was rejected because filesystem discovery, parsing, and watching add lifecycle machinery that an immutable single-skill provider does not need.

## Consequences

The badge instructions and source PNG are versioned with DSH and resolve through a packaged directory resource base. The provider has no configuration surface. Package tests pin provider lifecycle and the official PNG bytes, while a keyless assembled-application snapshot pins the enabled catalog and loaded skill body.
