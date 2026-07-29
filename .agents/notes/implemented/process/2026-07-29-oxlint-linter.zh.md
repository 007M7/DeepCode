# Agent Note: 使用 Oxlint 作为仓库 linter

Status: implemented

[English](2026-07-29-oxlint-linter.md) | 中文

## 问题

仓库的自有源码需要类型感知的 TypeScript 正确性规则、一致的格式，以及文件内重复逻辑检查。ESLint 通过 JavaScript 解析器、项目服务和多个插件提供这些检查，但在本地迁移基线上，一次无问题的 lint 运行约需 1 分钟，并且需要 8 GiB Node 堆、CI 结果缓存和单独调优的 ESLint 并发度。

不能以提高运行速度为由丢失规则。迁移必须保留严格类型检查预设、仓库覆盖配置、内联抑制指令、@stylistic 修复、SonarJS 检查、host/client TypeScript 隔离和 vendor 排除规则。

## 决策

根目录的 [`.oxlintrc.json`](../../../../.oxlintrc.json) 是 lint 配置；包（package）脚本、门禁调度器、CI 和 lefthook 使用的唯一 lint 命令均为 `oxlint`。直接的 `eslint` 和 `typescript-eslint` 开发依赖以及 `eslint.config.mjs` 均不存在。

`options.typeAware` 启用 `oxlint-tsgolint`。该配置显式载入迁移后的严格类型检查规则和仓库覆盖配置，而不启用内容可能发生变化的 Oxlint 宽泛类别。`typescript/no-unnecessary-condition` 仍从 Oxlint 的 nursery 规则集中启用，因为它在迁移前就是仓库强制执行的规则。Oxlint 会发现每个文件所属的 TypeScript 项目；现有包项目及相互独立的 host/client 聚合项目仍是类型上下文的真源。

Oxlint 的 JavaScript 插件兼容层运行 `@stylistic/eslint-plugin` 和 `eslint-plugin-sonarjs`，从而继续强制执行现有的格式和文件内重复逻辑规则。这些包的 ESLint 对等依赖（peer dependency）仍会作为传递依赖保留，但仓库既不配置也不调用 ESLint 运行器。自有源码中的抑制指令使用 `oxlint-*` 指令和 `typescript/*` 命名空间；vendor 源码保留其上游指令，因为 Oxlint 会排除 `vendor/**`。

CI 不恢复或保存 lint 结果缓存。`DSH_OXLINT_THREADS` 可以在门禁调度器中限制 Oxlint 的原生工作线程数，供共享运行器或基准测试运行器使用；普通本地运行使用 Oxlint 默认值。Pre-commit 对暂存的 JavaScript 和 TypeScript 文件应用安全的 Oxlint 修复，并由 lefthook 重新暂存这些文件。

## 验证

解决两处分析器差异后，迁移后的配置报告与迁移前一致的自有源码无问题基线：移除了一项冗余测试断言，而 `tsc` 要求的一处结构性类型转换使用了窄范围的 Oxlint 抑制指令。仓库 lint 命令会运行类型感知规则和两个 JavaScript 兼容插件。针对门禁调度器的聚焦执行覆盖显式线程上限路径，类型检查则确认迁移引发的源码改动没有破坏 TypeScript 程序。

## 考虑过的替代方案

**先运行 Oxlint，再使用精简的 ESLint 回退。** 当必要规则尚未得到支持时，这是推荐的渐进迁移路径；但仓库强制执行的所有规则均可通过 Oxlint 原生规则、nursery 规则或 JavaScript 插件兼容层获得。保留两个运行器会继续承担较慢的程序初始化和两套配置，却不会增加任何检查。

**移除尚无原生实现的 @stylistic 或 SonarJS 规则。** 这会移除依赖，但也会削弱机械质量契约。兼容层会保留这些规则，直到能够通过单独决策评估原生替代规则。

**迁移期间用 Oxfmt 替换 @stylistic。** 格式化器迁移会产生超出 lint 引擎边界的输出变化，并带来全仓库格式 diff。保留既有规则可使本次变更便于评审，并让格式化器选择保持独立。

## 结果

本地迁移测量显示，不使用结果缓存时，一次无问题的类型感知 lint 运行从约 61 秒缩短至约 8 秒。确切比例因主机而异，不构成性能保证。

类型感知诊断现在来自通过 `oxlint-tsgolint` 捆绑的 TypeScript Go 分析器，因此即使 `tsc` 接受同一程序，边界场景下的类型推断也可能与 typescript-eslint 不同。lint 与类型检查仍是两项相互独立的必要证据。

JavaScript 插件兼容 API 是需要维护的额外边界，其对等依赖图中仍包含 ESLint 包。不过，可执行 lint 路径、配置所有权、缓存政策、工作线程控制和内联指令已全部只使用 Oxlint。
