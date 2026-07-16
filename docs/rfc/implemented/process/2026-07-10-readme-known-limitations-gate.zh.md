# RFC：在每个 package README 中设置受门禁保护的「已知限制」章节

Status: implemented

[English](2026-07-10-readme-known-limitations-gate.md) | 中文

## 问题

[文档标准](../../../AGENTS.md)将限制事项归属于 package README。如果没有统一的格式，缺失的章节无法区分「经过审计确认无限制」和「忘记写了」，而各式各样的标题也让仓库级搜索无从下手。

## 决策

`packages/<group>/<pkg>/package.json` 下的每个 package manifest（元数据清单）都有一个同级 README，其中包含规范的 `## Known Limitations and Deferred Work` 章节。该章节的条目记录该 package 拥有的持久性消费方缺口与非显而易见的维护约束；普通的清理工作留在源码 TODO 或所属 RFC 中。[`verify-package-readme-limitations` 门禁](../../../../scripts/verify-package-readme-limitations.ts)从 manifest 推导 package 集合，拒绝缺少 README 的情况，并要求恰好有一个规范的 h2 标题且至少包含一个顶级条目。近似标题（如 "Limitations"、"Deferred"、"What is NOT here" 或 "Non-goals"）会导致失败。

如果一个 package 确实没有需要声明的限制，则将其列入 `NO_LIMITATIONS` 并省略该章节。新增限制时必须移除该条目；重命名或删除条目会失败，因为每个条目必须对应一个被扫描的 package。

门禁检查存在性、格式和白名单。覆盖率与准确性由文档标准和[行文标准](../../../../.agents/skills/dsh-prose-standard/SKILL.md)下的评审负责。常设规则见 [packages/AGENTS.md](../../../../packages/AGENTS.md)。

## 曾考虑的替代方案

- **自由格式标题**：无法统一搜索，仍然需要近似标题检测。
- **要求空章节或写 "None."**：样板文字可能在 package 新增限制后仍然残留；白名单使「确认无限制」显式且可评审。
- **施加字数上限**：合理的限制条目数量因 package 而异，因此由评审管控这一不设预算的 README 层级。

## 后果

- 新 package 要么声明符合条件的限制事项，要么显式加入白名单；缺失、漂移或空白的章节会在本地和 CI 的 `doc-sync` 中失败。
- 门禁向 `doc-sync` 新增一个无外部依赖的 TypeScript 脚本。
- 重命名被强制的标题需要同时修改脚本和所有 package README。
