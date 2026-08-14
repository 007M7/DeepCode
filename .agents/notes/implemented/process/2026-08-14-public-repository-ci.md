# Agent Note: Public repository CI defaults

Status: implemented

English | [中文](2026-08-14-public-repository-ci.zh.md)

## Problem

DeepCode uses a public GitHub repository without the upstream organization's private runner pools, issue-management GitHub App, project, publishing credentials, or real-API test key. Workflows that require those resources can remain queued indefinitely or fail before executing a source check.

## Decision

The default-branch and pull-request quality checks use standard GitHub-hosted runners. A push to `main` runs the complete keyless primary aggregate; pull requests retain split Linux, compatibility, Python, Wine, and native Windows checks for useful failure attribution. Upstream self-hosted standby jobs remain disabled references.

The real-API workflow detects `DEEPSEEK_API_KEY_EXTERNAL` without printing it. When configured on a trusted event, the workflow builds the release-form application and runs the real API suite. When absent, it emits an explicit notice and skips every credential-dependent setup and test step; the independent keyless CI result remains the source-quality verdict.

Upstream issue and project automation runs only when `DEEPCODE_ISSUE_AUTOMATION_ENABLED` is `true` and its App credentials are configured. Release publication remains manually gated by its registry credentials. Workflow branch filters follow the repository's `main` default branch.

## Alternatives considered

**Copy the upstream private infrastructure.** Rejected because a public checkout cannot rely on organization-owned runner labels, GitHub App installations, projects, or secrets.

**Fail when the optional real-API key is absent.** Rejected because this reports repository configuration as a code regression. An explicit non-execution notice preserves the distinction without claiming that the suite ran.

**Remove credentialed workflows.** Rejected because maintainers can add the required repository configuration later without restoring deleted coverage or publication definitions.

## Consequences

Fresh forks and dependency pull requests receive runnable keyless checks without private infrastructure. Real-provider behavior is not verified until a maintainer configures the external API key, and issue lifecycle automation remains inactive until its repository variable and App credentials are provisioned.
