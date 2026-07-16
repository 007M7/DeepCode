# RFC：将包（package）重组为模块化层级结构

[English](2026-06-20-package-hierarchy.md) | 中文

Status: implemented

## 问题

`packages/` 原先是扁平的：18 个包全部位于 `packages/<name>/`，一个包的位置无法体现它是核心产品 API、可替换的能力 seam、提供方适配器、产品集成，还是示例/测试支撑。package README 带着 `FIXME(package-hierarchy)`，`scripts/publint-all.ts` 带着 `TODO(package-inventory)`，标记的正是这个问题。核心包、提供方集成、能力 seam、示例 UI 支撑和仅用于快照的回放支撑，看起来都同等基础。

这不仅是外观问题。因为每个顶层包看起来都属于同一个公开接口面，未来移除更难；发布/lint/文档脚本不得不通过注释或手工维护的静态列表来编码意图，而非从布局直接读取。

## 决策

按模块角色分组，统一为 `packages/<group>/<pkg>/` 两层深度。分组目录是纯容器（没有 `package.json`）；每个包保留其 `@deepseek-ai/dsh-<pkg>` 名称——这是仓库结构与维护策略，不是包重命名。

```text
packages/
  core/                  (product API spine)
    session/
    system-prompt/
    tools/
    agent/
    agent-loop/
  llm/                   (product — capability family)
    llm/
    llm-deepseek/
    llm-pi-ai/
  bash/                  (product — capability family)
    bash/
    bash-local/
    tool-bash/
  session-persistence/   (product — capability family)
    session-persistence/
    session-persistence-jsonl/
    session-persistence-sqlite/
  ui/                    (product integration)
    acp/
  support/               (dev/test/example infrastructure)
    invariants/
    ui-stdio/
    llm-replay/
```

### 放置决策

- **能力族使用同名嵌套。** 一个族的接口包位于 `packages/<group>/<group>/`（`llm/llm`、`bash/bash`、`session-persistence/session-persistence`），实现和消费方作为扁平兄弟。不设额外的 `adapters/`/`impls/` 子层——每个包恰好在深度 2，workspace glob 保持简洁的 `packages/*/*`，一条 `@deepseek-ai/dsh-*` tsconfig 通配符即可解析所有包（目录名唯一，使 first-on-disk-wins 无歧义）。
- **`session` 留在 `core/`；持久化自成一族。** 会话日志是核心产品 API。其存储后端构成一个平行的能力族（`session-persistence/`），与 `llm/` 和 `bash/` 对称，而非嵌套在 `core/session/` 下。
- **`agent-loop` 在 `core/` 中。** 它是 `agent` seam 唯一的具体实现，但作为 harness 的默认产品循环随产品发布，因此与核心主干同住。插件仍然依赖 `agent` 的词汇，从不依赖 `agent-loop`，因此循环仍可替换。
- **`invariants` 和 `ui-stdio` 属于 `support/`，不是产品。** `invariants` 是开发模式的契约检查。`ui-stdio` 从示例中提取以便复用和满足覆盖率门禁——它与示例耦合，因此与 `llm-replay`（快照测试回放适配器）一起放在 `support/` 中。`acp` 是 `ui/` 的唯一成员，因为它是真正的产品接口面（编辑器驱动的 ACP 桥接），在结构上不同于 readline 演示辅助工具。

### 去重包清单

包清单此前在五处重复枚举。统一的深度 2 布局使大部分可以被推导出来：

- `tsconfig.base.json` 通过一条 `@deepseek-ai/dsh-*` `paths` 通配符（每个分组列一个候选路径）映射所有包，取代逐包条目。根 `tsconfig.json` 复用该源码映射，并携带显式的 project references 以保持 package/vendor 类型检查边界完整。（这里引入了一个细节：路径候选包含 `/*/`，朴素的正则注释剥离器会误认为块注释——`scripts/doc-typecheck.ts` 正是因此通过 TypeScript 解析器读取 JSONC 配置，而非手工剥离注释。）
- `scripts/publint-all.ts` 通过读取层级结构（`packages/<group>/<pkg>`）推导出列表，解决了 `TODO(package-inventory)`。
- `tsconfig.build.json` 的 project `references` 仍为显式列表——TypeScript project references 没有通配符形式。从 manifest 生成这些引用留作后续工作（见 [discover package inventories](../../proposed/process/2026-06-20-discover-package-inventory.md)）。

### 新增的护栏

两道 doc-sync/hygiene 门禁保证结构及其引用的正确性，使本次重组所需的人工检查不必再次手动重复：

- `scripts/verify-package-paths.ts` 标记 Markdown 或 `.ts` 注释/字符串中的 `packages/<path>` 引用：如果该路径无法解析**且**某段命名了一个真实存在的包，则视为指向已移动包的陈旧路径。如果路径命名的包在任何地方都不存在（前瞻性提案），则不报错；因此该门禁对 proposed/implemented/rejected 统一适用。
- `scripts/check-workspace-constraints.ts` 断言 `packages/<group>/<pkg>` 形状：分组目录不含 `package.json`，没有包扁平地位于根层级或嵌套更深。分组名称保持开放——新增分组无需修改门禁；只有深度 2 的形状是固定的。

## 曾考虑的替代方案

- **第三层（每个族下设 `adapters/`/`impls/`）**：否决。统一深度 2 使 workspace glob 保持简洁的 `packages/*/*`，一条 `@deepseek-ai/dsh-*` tsconfig 通配符即可解析所有包。
- **将持久化嵌套在 `core/session/` 下**：否决。存储后端构成一个平行的能力族，与 `llm/` 和 `bash/` 对称，而会话日志本身属于核心产品 API。
- **`ui-stdio` 放在 `ui/` 下**：否决。它是与示例耦合的开发支撑，不是产品接口面；`acp` 是 `ui/` 的唯一成员，因为编辑器确实在驱动它。

## 后果

本次重组在一次协调的变更中搅动了 import、workspace glob、文档链接、构建引用和包路径。这种搅动在发布前是可接受的（遵循 AGENTS.md 中「基础优先于爆炸半径」的立场），因为它阻止了扁平布局将支撑包固化为产品契约；而且这是一次性成本：通配符 `paths`、glob 推导的 publint 列表和形状门禁意味着新增一个包无需再做额外的结构编辑。
