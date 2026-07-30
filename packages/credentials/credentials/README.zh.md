# dsh-credentials

[English](README.md) | 中文

抽象的只读凭据 seam（`ctx.credentials`）。配置携带 `DEEPSEEK_API_KEY` 这样的品牌化引用；值归提供方所有，消费方只在操作开始时解析它。

## 接口面

```ts
import type { Context } from 'cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

declare const ctx: Context

const ref = credentialRef('DEEPSEEK_API_KEY')
const value = await ctx.credentials.resolve(ref) // string | undefined
```

`credentialRef()` 接受 POSIX 风格的环境变量名并为其添加品牌类型，使引用不会与其他跨包（package）字符串混用。`resolve(ref)` 返回当前非空值，未配置时返回 `undefined`。消费方每个操作解析一次，不跨操作缓存；在当前消费方需要之前，seam 不引入修改、来源元数据、枚举或变更事件。

## Providers

[`dsh-credentials-local`](../credentials-local/README.md) 把活跃进程环境叠加在 `$DSH_HOME/.env` 文件之上。其他提供方可以从 keyring、辅助命令或 KMS 解析相同的引用词汇，而无需改动消费方。

## Model Experience

经由消费它的 LLM（大语言模型）适配器间接生效：解析出的值为适配器的提供方请求授权，每个模型可见面都归适配器所有。

#### KV Cache effect

无直接失效；凭据绝不进入请求前缀。

## Known Limitations and Deferred Work

- **不提供修改、描述或枚举**：seam 只解析消费方配置已经点名的引用；凭据管理 UI 需要自身有明确依据的契约。
- **引用限定为环境变量形状**：单一扁平的 POSIX 标识符命名空间足以满足当前消费方。
