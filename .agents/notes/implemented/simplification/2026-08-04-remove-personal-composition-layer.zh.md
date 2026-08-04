# Agent Note: 删除个人 composition 层

Status: implemented

[English](2026-08-04-remove-personal-composition-layer.md) | 中文

## Problem

`$DSH_HOME/config.yaml` 是一个隐式的 composition 层：只要该文件存在，每次 `dsh` 启动都会在已交付配置树上应用一张任意的 Loader patch 图，而 TUI 与 Web 还用一个专门的 HMR watcher 让它保持热更新。随之而来的三项代价来自「隐式」，而不是来自这项能力本身。

patch 会替换目标行的整个 `config`，因此几个月前写下的个人文件会把那一行钉死在它当时知道的字段集上。此后交付端给该行新增的每个默认值都会静默失效，而除非跑 `--dump-config`，否则没有任何东西会暴露这一点。每次启动都应用它，等于把一次性编辑变成了长期偏离。

它还在同一批值上与类型化 settings 争夺所有权。`llm-deepseek` 与 `llm-pi-ai` 都注册了 settings namespace，而同样的字段也能通过 patch 它们的行抵达——于是谁赢取决于层序，而不取决于这个值的语义。这正是 [user-settings seam](../architecture/2026-07-28-user-settings-seam.md) 要消除的所有权歧义。

最后，本应与它互为冗余的那条显式通道并未覆盖所有界面：`dsh -p`、`dsh meta` 和 `dsh upgrade` 都拒绝 `--config`。对这些界面来说，隐式文件不是两条 composition 路径之一——它是唯一的一条。

## Decision

删掉隐式的那一层，并把显式的那一层补完整。

**每个会启动的界面都接受 `--config` 与 `--config-replace`。** `dsh -p`、`dsh meta` 和 `dsh upgrade` 与 TUI 看齐，因此只要有配置树启动的地方，就能点名一棵树。无头模式下的 `--config-replace` 树仍必须挂载 webserver 行，因为该界面是通过浏览器所用的同一个 HTTP 网关访问自己的 agent 的；`AppCLIEntry` 现在会在失败信息里说明这条契约，而不是只报告某个服务缺失。

**`$DSH_HOME/config.yaml` 不再被读取、监视或 dump。** `PERSONAL_CONFIG_FILENAME`、`loadPersonalPatches`、`watchPersonalPatches`，以及专为它挂载的那一行 config-only HMR，全部删除。留在该路径上的文件是惰性的。Harness home 仍然保有 `settings.yaml`、`.credentials.yaml` 和 `.env`；overlay 也仍然可以放在那里，但它是一条待点名的路径，而不是一层待发现的配置。

因此 `--config` 的含义略有变化：它过去是*替代*个人 overlay，现在它本身*就是*用户 overlay。`--config-replace` 保持不变。

日常能力各自保有归属。模型与 provider 参数已经属于各适配器的类型化 settings namespace。`repository-plugins` 行随交付配置以空列表挂载，因此仓库插件列表今天是一个 `--config` overlay，等 settings namespace 落地后归它。MCP 服务器仍然是 `--config` composition，这也是 [CLI README](../../../../apps/cli/README.md) 现在的写法。

不做迁移，也不给弃用诊断：产品尚未发布，想要旧行为的用户点名同一个文件即可（`dsh --config ~/.dsh/config.yaml`），配一个 shell alias 就是永久的。

## Consequences

- 放弃的：一份无需点名就跨启动跟随你的 composition。恢复它只需一个 alias，而这正是重点——插件图现在由一次启动声明，而不是由机器持有。
- 放弃的：composition 文件的热重载。settings 与凭据各自保留 watcher；composition 变更现在需要重启，而这本来就是 `--config` 对每一棵显式树的既有含义。
- 换来的：只有一条 composition 路径而不是两条；已交付配置树不会被静默钉死在陈旧字段集上；类型化 settings 成为其所声明的值的唯一所有者。
- [个人配置特性 Note](../feature/2026-07-20-dsh-cli-personal-config.md) 只被部分取代——它引入的 `dsh` CLI（命令行界面）仍然成立——因此两条 Note 保持互链，其中关于 config overlay 的事实已就地改写。
- `--dump-config` 打印已交付基座、surface overlay 以及任何被点名的 `--config`；不带标志时只打印已交付组合，因此 Harness home 不再改变 dump 的内容。

## Alternatives considered

**保留该文件，只是不再监视它。** 否决：watcher 是较小的那一半。长期代价在于一份旧 patch 列表会在每次启动时静默钉死一个已交付行，而只在启动时读取恰恰完整保留了这一点。

**从 `settings.yaml` 里点名 overlay（`compositionOverlay: ~/.dsh/my.cordis.yml`）。** 否决，且值得写明，因为它看起来两全其美：它保留了促成本次删除的那条运行时性质——每次启动都应用一张任意插件图——只是把触发条件从「文件存在」换成「字段已设置」。更糟的是，`settings.yaml` 由产品自己的设置界面写入，那等于让设置页面能编辑 composition 树。

**等 settings 驱动的 repository 与 MCP manager 落地后再删。** 在 `--config` 覆盖所有界面之后，这条依赖已无必要，故否决：那两个 manager 会让这两种场景*更好用*，但只要标志处处可用，先删掉隐式层就不损失任何东西。

**只为 `dsh -p` 保留它，因为那里原本没有标志。** 否决：那恰恰是最需要显式的界面。CI 或脚本化运行应当点名自己的 composition，而不是继承机器上恰好存在的东西。
