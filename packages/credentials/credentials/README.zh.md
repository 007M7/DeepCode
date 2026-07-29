# dsh-credentials

[English](README.md) | 中文

抽象凭据 seam（`ctx.credentials`）。一条准则，三个推论：

**配置只携带对秘密的引用，绝不携带秘密本身。** settings 分节或 `cordis.yml` 条目写 `apiKeyEnv: DEEPSEEK_API_KEY`，引用背后的值归凭据 provider 所有。于是设置文档可以放心同步、放心渲染进配置界面；`describe()` 无需持有值就能回答"配置了吗、来自哪层、能否写入"；轮换秘密不触碰任何配置文件。

**消费方按操作解析。** `resolve(ref)` 在每个操作开始时调用（LLM adapter 每次模型请求解析一次），绝不跨操作缓存——正是这次读取让改过的凭据无需重启任何插件就作用于下一次请求。

**空的存储值等于不存在。** 处处如此：`resolve` 跳过它，`describe` 报告未配置。空白永远不会伪装成已配置的秘密。

## 接口面

```ts
import { credentialRef } from '@deepseek-ai/dsh-credentials'

const ref = credentialRef('DEEPSEEK_API_KEY')            // POSIX shell 标识符，品牌类型
const hit = await ctx.credentials.resolve(ref)           // { value, source } | undefined
const info = await ctx.credentials.describe(ref)         // { configured, source?, writable } —— 绝不含值
await ctx.credentials.set(ref, 'sk-…')                   // 被只读来源遮蔽时拒绝
await ctx.credentials.unset(ref)                         // 不存在时为 no-op；同样的遮蔽规则
```

`credentials/updated (ref)` 在 provider 管理的来源发生已提交变更后触发——`set`、`unset` 或在存储中观察到的外部编辑。进程环境变量的变化不可观测，永不触发。消费方不需要该事件（它们按操作重新解析）；它服务于配置界面刷新"已配置"徽标。

`set`/`unset` 的遮蔽规则是刻意的 fail-loud：当只读来源（本地 provider 中即活跃进程环境）正在提供该引用时，写入会表面成功而解析仍返回遮蔽值——seam 选择直接拒绝，并通过 `describe().writable` 让界面提前把该引用渲染为只读。

## Providers

[`dsh-credentials-local`](../credentials-local/README.md) 把活跃进程环境叠加在 `$DSH_HOME/.env` 文件之上。seam 形状为 keyring、辅助命令、KMS 后端的 provider 留好了位置；远端 settings provider 永远不必携带秘密。

## Model Experience

Indirectly: a resolved value authorizes provider requests; the consuming adapter owns every model-visible surface.

#### KV Cache effect

No direct invalidation; credentials never enter a request prefix.

## Known Limitations and Deferred Work

- **不提供枚举**——seam 只回答被问到的引用；配置界面从 settings schema 得知引用集合，`list()` 没有当前消费者。
- **引用限定为环境变量形状**——在有 provider 需要更丰富寻址前，保持单一扁平的 POSIX 标识符命名空间。
- **进程环境变化不可见**——不可能为其发事件；界面只能在自身导航时重新读取 `describe()`。
