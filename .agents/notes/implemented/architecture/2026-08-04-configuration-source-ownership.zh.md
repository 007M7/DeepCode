# Agent Note: 配置来源的统一顺序，以及被发现的文件不得决定什么

Status: implemented

[English](2026-08-04-configuration-source-ownership.md) | 中文

## Problem

`$DSH_HOME/.env` 刚刚[变成普通环境层](2026-08-04-credentials-yaml-and-user-environment-layer.md)，这使得 harness 解析面向用户的值时面对的是一个压平的 `process.env`，再也说不清某个值来自哪里。由此产生三个后果。

通过 Web 页面存下的密钥仍然被用户自己 `.env` 里更旧的密钥遮蔽，因为凭据 provider 是拿「环境」与自己的文件比较，而现在环境包含了那个文件。这次拆分本该消除的迁移死路，只是换了个位置。

endpoint 可以被项目重定向。调用目录的 `.env` 和其他层一样会被物化，而 base URL 决定已解析的 API key 发往何处——于是写进模型可编辑工作区的 `DEEPSEEK_BASE_URL`，会把用户自己的凭据、以及承载其代码的提示词，一起发给该文件指定的任何主机。压平的视图无法把这件事和运维显式 export 同一个变量区分开。

而已交付组合里的 `!!js process.env.X` 让同一个值有两条抵达路径：一条经 entry config，一条经消费方各自的 ladder，胜负取决于层序而非这个值的语义。

## Decision

**一条顺序，四类来源。** 每个面向用户的值按同一顺序解析；各领域的差别只在于哪些层存在。

```text
explicit for this run     per-operation override, CLI argument
> authored by deployment  --config / --config-replace
> this launch's shell     inherited process environment
> product-managed store   settings.yaml, .credentials.yaml
> discovered file         $DSH_HOME/.env
> defaults                schema default, shipped base, provider public default
```

自上而下依次是：本次运行的显式意图、部署授权、本次启动的 shell、产品受管存储、被发现的文件、默认值。

凭据没有部署层（配置携带引用，从不携带值），也没有默认值层。endpoint 拥有全部层。模型选择只有 CLI、settings 与已交付默认值。此前的方案把 UI 写入的凭据排在环境*之下*，却把 UI 写入的 settings 排在环境*之上*；真正的区分依据不是领域，而是这个文件由谁书写，因此 `.credentials.yaml` 与 `settings.yaml` 现在并列，同在启动 shell 之下、同在被发现的 `.env` 之上。

**调用目录的 `.env` 不决定任何凭据与路由。** `EnvironmentSnapshot.getFrom(name, sources)` 只搜索调用方点名的层，省略某层是拒绝而不是降级：适配器请求的是 `['process', 'user-env']`，因此后续任何重新排序都无法让项目文件重新进入一个它被排除在外的决策。对普通变量而言，项目 `.env` 仍然是普通环境层。

**被发现的文件不得决定进程如何启动。** `isBootstrapOnly` 会在加载时、且在物化任何内容之前，拒绝任何设置了下列变量的 `.env`：决定进程如何启动的（`PATH`、`SHELL`、`NODE_OPTIONS`、`LD_PRELOAD` 等）、决定代码或模型可见指令从哪里加载的（整个 `DSH_*` 命名空间、`HOME`、`XDG_*`），以及决定网络如何抵达与信任的（proxy 与 CA 变量）。匹配不区分大小写，因此 `https_proxy` 不是绕过手段。

被拒绝的是整个 `DSH_*` 命名空间，而不是一份经过审查的子集。harness 自己的开关——权限模式、存放模型可见 skill（技能）的 agents home、内置 skill 根目录——恰恰是敌意项目最想伸手的地方，而后来新增的开关不能因为被遗忘就变得可设置。不设逃生门：逃生门本身总得从某处读取，而任何被发现的文件能设置的东西，就是那个漏洞本身。

**`packages/util/environment` 拥有该快照**，刻意做成 utility 而不是三包能力 seam。快照在 Cordis 启动前就冻结，并由启动器一次性注入，因此不存在需要切换的运行时实现；消费方需要的只是类型和纯函数，而 `util/` 包能提供这些且不必依赖 UI 包。`environmentOf(ctx)` 返回启动器的快照，或者返回只含继承环境的那一层——SDK 宿主或裸 `cordis.yml` 从未发现过任何文件，它那唯一一层确实就是它被启动时的环境，因此同样的受信查询在那里原样继续工作。

**`verify-config-source-ownership`** 守住这两条规则：`packages/*/*/src` 下没有未登记的 `process.env` 读取（26 处在 allowlist 中，各自写明它为何是进程事实），以及已交付 Cordis 配置中不得从环境内联 `apiKey`/`baseURL`/`headers`。删除这些内联正是「部署层」得以成立的原因——已交付配置树对 `baseURL` 保持沉默之后，「有值」就意味着「人或部署设过它」。

## Consequences

- Web 凭据表单现在能压过用户 `.env` 里更旧的密钥；只有在启动 shell 里 export 的密钥才会让它变成只读，诊断信息也会这么说。
- 含 `DSH_*`、`PATH` 或 proxy 变量的 `.env` 会导致启动失败而不是被应用。把开关放在仓库 `.env` 里的开发者需要改放到 shell——这是一次刻意且响亮的破坏。
- `--config` 不再会被陈旧的 shell endpoint 覆盖，因此部署方可以钉住企业网关。
- 放弃的：调用目录 `.env` 里的 endpoint 或密钥不再生效。按项目切换路由请用 `--config` overlay 或该项目 shell 里的 `export`。
- 未解决的：各层仍然会被物化进 `process.env`，因此普通项目变量继续按子进程清洗规则抵达子进程。bootstrap 变量完全不能来自文件，提权路径已封闭；项目 `.env` 为 agent 运行的工具设置诸如 `GIT_SSH_COMMAND` 之类的变量仍然可能，已作为限制记录在该包上。
- Exa 与 Perplexity 仍在加载时捕获密钥，而不是经凭据 seam。它们不再读裸 `process.env`——改为经受信层解析——但把它们改造成按请求经 seam 解析是另一件事。

## Alternatives considered

**沿用方案里分开的两条 ladder（凭据环境压过文件、endpoint settings 压过环境）。** 因其自身的不自洽而否决：两条理由——「export 是本次运行的意图」和「部署方的文件不该被陈旧 shell 改写」——对两个领域同样成立。按*来源由谁书写*排序能同时解释两者，并且把四张表变成一张。

**允许调用目录 `.env` 提供凭据，排在受管存储之下。** 否决：在没有存储密钥时，敌意项目的密钥会被静默使用，而该账号持有者能读到以它发出的每一条提示词。这与 endpoint 规则要防的外泄是同一件事，因此答案也相同。

**审查出一份 `.env` 可设置的 `DSH_*` 白名单。** 否决：每新增一个开关都要重新审查，而遗漏的失败模式是静默的。拒绝整个命名空间是 fail safe。

**把 bootstrap 变量排在 process 层之下，而不是拒绝它。** 否决：`PATH` 和 `NODE_OPTIONS` 没有有意义的「输了之后」行为——把它写进 `.env` 的用户认为它生效，而静默忽略正是整个系列要消除的那种「我的设置没有效果」。

**把快照做成三包能力 seam（`environment` / `environment-local` / 消费方）。** 作为过早拆分而否决：生产方在 Cordis 存在之前就运行，也没有第二个实现需要选择。仓库规则是不要预先拆分。

**不再把各层物化进 `process.env`。** 延后而非否决：它能让项目变量彻底进不了子进程，但会静默破坏任何读 `!!js process.env.X` 的用户 `--config` 树。快照已经是 harness 解析一切的依据，因此这件事以后落地也不改变任何 ladder。
