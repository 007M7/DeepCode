# Agent Note: 把门禁脚本统一到已有依赖与内置模块上

Status: proposed

[English](2026-07-26-consolidate-gate-scripts-on-existing-deps.md) | 中文

## 问题

`scripts/` 下的门禁大多已经在用正确的工具（15 个以上的门禁使用 `node:fs` 的 `globSync`，markdown 门禁使用 mdast/micromark），但少数几个掉队的脚本仍在手写同类门禁早已用既有依赖或内置模块完成的事情：

- **重复的围栏扫描器。**`scripts/md-fences.ts`（约 55 行，由 `doc-typecheck.ts` 消费）和 `scripts/verify-type-equiv.ts` 中的 `extractEquivBlocks`（约 39 行）是同一个围栏代码块正则行扫描器的两份拷贝，而 `scripts/verify-mermaid.ts` 已经通过共享的 `scripts/markdown.ts` 辅助函数访问 mdast `code` 节点来提取代码围栏；`markdown.ts` 自己的 `markdownProseLines` 也是先解析成 mdast，再用第二个正则手工跟踪围栏状态。这两个正则扫描器只识别第 0 列的反引号围栏，因此在波浪线围栏和缩进围栏上与基于 mdast 的门禁悄悄不一致。
- **手写的 argv 解析。**`scripts/publint-all.ts` 中的 `parseOptions` 和 `scripts/verify-built-package-invariants.mjs` 中与之几乎相同的拷贝（约 26 行）手工推进 argv 下标，而同类脚本（`verify-runtime-closure.ts`、`build-exe-for-python-sdk.ts`、`packages/sdk/scripts/src/args.ts`）已经在使用 `node:util` 的内置 `parseArgs`。
- **手写的目录遍历。**五处代码各自重写了 `globSync` 已覆盖的嵌套 `readdirSync` 遍历：`verify-runtime-closure.ts` 对 packages 与 vendor manifest（元数据清单）的扫描、`dev-web.ts` 的 `discoverPluginDirs`、`verify-package-paths.ts` 的 `realPackageNames`、`verify-client-domain-graph.ts` 的 `listSources`，以及 `publint-all.ts` 的 `addPath`（合计约 55–65 行）。`scripts/package-invariants.ts` 展示了一行式的 `globSync` 模板。

所有替换都不需要引入新依赖；每一处替换用的都是既有的 devDependency 或 Node 内置模块。

## 提案

- 在 `scripts/markdown.ts` 中提取一个约 10–15 行的共享 mdast 围栏辅助函数（访问 `code` 节点，读取 `lang`、`meta`、`value`、`position.start.line`）；把 `doc-typecheck.ts` 和 `verify-type-equiv.ts` 改写到它上面；删除 `md-fences.ts` 和重复的扫描器；去掉 `markdownProseLines` 中冗余的围栏正则。
- 用 `parseArgs` 替换两份 `parseOptions` 拷贝。
- 用 `globSync` 替换那五处掉队的目录遍历。保留 `check-workspace-constraints.ts` 和 `clean.ts` 中的遍历：它们需要 dirent 级别的细节来诊断结构异常的目录树，按模式匹配的 glob 报告不了这些信息。

## 曾考虑的替代方案

- **新的 glob/目录遍历依赖（`tinyglobby`、`fdir`）。**不予采纳：内置模块已在全仓库范围内胜出；这几处只是掉队者，不是能力缺口。
- **用 `p-map` 替换 `publint-all.ts` 中约 19 行的有序 worker 池。**刻意未纳入：为一次小删除引入一个新 devDependency，正处在[依赖策略](../../implemented/process/2026-07-26-dependencies-over-hand-rolling.md)门槛的边缘，而且该池的需求（worker 数量有界、确定性顺序、环境变量覆盖）已记录在[并行 pre-push 门禁决策记录](../../implemented/process/2026-07-06-parallel-pre-push-gates.md)中。仅当 `p-map` 赢得第二个消费方时再顺带纳入。
- **保留这两个围栏扫描器。**不予采纳：在第三个正确实现旁边放着两份逐渐漂移的解析器拷贝，正是共享的 `markdown.ts` 辅助函数要防止的那种重复；「只认第 0 列反引号」的限制也是同类门禁之间的潜在不一致。

## 验收标准

- `md-fences.ts` 已删除；`doc-typecheck` 与 `verify-type-equiv` 通过 `scripts/markdown.ts` 提取代码围栏；`pnpm run doc-sync` 在当前代码树上通过且结果不变（如有差异，必须能追溯到正则扫描器处理有误的某种围栏形态）。
- 两个 CLI 都改用 `parseArgs` 解析；未知选项仍然大声失败。
- 五处遍历代码改用 `globSync`；它们供给的门禁保持原样通过。

## 风险

- 病态 markdown 上的行为差异：mdast 会承认正则扫描器忽略的波浪线围栏和缩进围栏，因此如果文档树中存在任何零散的此类围栏形态，`doc-typecheck` 的 opt-out 比例可能变化；应在改动前后分别运行 `doc-sync` 加以验证。
- `parseArgs` 对重复出现的选项保留最后一个值而不报错——一个测试未固定的开发工具边缘用例。（严格模式下，需要取值处遇到以 `--` 开头的 token 仍会拒绝，与现有解析器行为一致。）
