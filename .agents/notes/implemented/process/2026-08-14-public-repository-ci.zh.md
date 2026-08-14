# Agent Note: 公共仓库 CI 默认配置

Status: implemented

[English](2026-08-14-public-repository-ci.md) | 中文

## Problem

DeepCode 使用公共 GitHub 仓库，但没有上游组织的私有 runner 池、Issue 管理 GitHub App、Project、发布凭据或真实 API 测试密钥。依赖这些资源的工作流会无限排队，或在执行源码检查前失败。

## Decision

默认分支与拉取请求的质量检查使用 GitHub 标准托管 runner。推送到 `main` 时运行完整的 keyless primary aggregate；拉取请求保留拆分的 Linux、兼容性、Python、Wine 与原生 Windows 检查，以便定位失败。上游 self-hosted standby job 作为禁用的参考保留。

真实 API 工作流检测 `DEEPSEEK_API_KEY_EXTERNAL`，且不会打印其值。在可信事件中配置该密钥后，工作流构建发布形态的应用并运行真实 API 测试。密钥缺失时，工作流明确提示并跳过所有依赖凭据的安装与测试步骤；独立的 keyless CI 结果仍是源码质量结论。

仅当 `DEEPCODE_ISSUE_AUTOMATION_ENABLED` 为 `true` 且 App 凭据已配置时，才运行上游 Issue 与 Project 自动化。发布仍由 registry 凭据手动控制。工作流分支过滤与仓库默认分支 `main` 对齐。

## Alternatives considered

**复制上游私有基础设施。** 不采用，因为公共检出不能依赖组织专用 runner 标签、GitHub App 安装、Project 或密钥。

**缺少可选真实 API 密钥时失败。** 不采用，因为这会把仓库配置问题报告为代码回归。明确提示未运行可以保留这一区分，同时不声称测试已经执行。

**删除依赖凭据的工作流。** 不采用，因为维护者以后可以补充仓库配置，无需恢复已经删除的测试与发布定义。

## Consequences

新 fork 与依赖更新拉取请求无需私有基础设施即可获得可运行的 keyless 检查。维护者配置外部 API 密钥前不会验证真实 provider 行为；配置仓库变量与 App 凭据前，Issue 生命周期自动化保持停用。
