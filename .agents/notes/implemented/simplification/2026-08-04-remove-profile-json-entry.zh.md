# Agent Note: 删除 profile-json 配置入口

Status: implemented

[English](2026-08-04-remove-profile-json-entry.md) | 中文

## Problem

`./.dsh-tmp-profile/config.json` 曾是 [web 配置树启动](../architecture/2026-07-24-web-config-tree-boot-and-transport-layering.md)的用户配置面：调用目录下的一个只读 JSON 对象，经静态 `PROFILE_MAPPINGS` 表映射到两个行上的三个字段。它的写路径以及迁往 Harness home 的计划都记在那条 Note 里作为延后项，两者都没有落地。产品中从未有任何代码创建或编辑该文件，没有测试覆盖它，也没有用户文档提到它——这个格式只存在读取方。

与此同时，它映射的字段各自有了别处的归属。`provider` 与 `model` 是 api-gateway 为新建和恢复的 agent 提供的默认路由，会话自己的选择器可按 agent 覆盖它；`persistenceRoot` 是交付组合的装配事实。类型化的用户偏好则由 [user-settings seam](../architecture/2026-07-28-user-settings-seam.md) 下的 `$DSH_HOME/settings.yaml` 承接。剩下的只是第三个用户配置格式：锚定在调用目录、藏在一张手工维护的映射表后面，而且没有任何东西写它。

## Decision

`PROFILE_DIR`、`PROFILE_FILE`、`ProfileMapping`、`PROFILE_MAPPINGS` 和 `readProfile()` 连同消费它们的那个 patch 来源一并删除。`AppCLIEntry` 现在只从 CLI 标志和解析出的前端 `distIndex` 合成 patch；它周围的各层——交付基座、surface overlay、以及 `--config` overlay——保持不变。

磁盘上的 `.dsh-tmp-profile/config.json` 现在被完全忽略。没有迁移、没有替代格式、也没有弃用诊断：该文件从来没有生产方，因此不存在需要承接的存量，而[未发布阶段的立场](../../../../AGENTS.md)拒绝兼容垫片。

## Alternatives considered

**保留读取方，直到类型化 settings 接管 `provider`/`model`。** 否决，因为这个缺口并不真实存在：既然没有写入方，该文件同样没有给用户任何钉住默认路由的途径，保留它保住的是一个无人生产的格式，而不是一项能力。

**按原 Note 记录的延后项，把它迁到 `$DSH_HOME`。** 否决，因为那条延后项的前提是写路径会随之到来。搬动一个没人写的文件只是搬动了这个死入口，而 Harness home 已经有了类型化用户偏好的归属者。

**文件存在时通过弃用诊断报告它。** 否决，因为为一个产品从未生产过的格式给出诊断，等于向从没见过它的用户宣传它。

## Consequences

- 放弃的：不再有基于文件、无需编辑 yml 或传 `--config` 就能钉住 `provider`、`model` 或 `persistenceRoot` 的途径。持久的默认路由需要一个由会话创建方拥有的类型化 settings namespace；`persistenceRoot` 仍是装配事实。
- 换来的：少一个用户配置格式，少一个锚定在调用目录的输入，以及一处仅剩 CLI 标志与装配事实两个来源的 patch 合成——那张 fail-loud 映射表随之消失。
- [web 配置树启动 Note](../architecture/2026-07-24-web-config-tree-boot-and-transport-layering.md) 只被部分取代：它关于组合、启动胶水、传输与导出的决策仍然成立。两条 Note 保持互链，其中与 profile 相关的事实已就地改写。
- 缺席由全仓搜索验证：`.dsh-tmp-profile`、`PROFILE_MAPPINGS` 与 `readProfile` 均无残留匹配。
