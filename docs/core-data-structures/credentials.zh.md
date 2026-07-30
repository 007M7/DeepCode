# 用户凭据

[English](credentials.md) | 中文

[dsh-credentials](../../packages/credentials/credentials) seam 允许配置以引用点名机密，而非携带机密值。[dsh-credentials-local](../../packages/credentials/credentials-local) 这类提供方解析当前非空值，消费方每个操作解析一次，因此从外部轮换的值无需重启即可作用于下一次操作。

Source: [`packages/credentials/credentials/src/index.ts`](../../packages/credentials/credentials/src/index.ts)

## 标识

引用以 POSIX 风格环境变量名命名一条凭据。brand 使引用不与其他跨边界字符串混用；构造时校验 shell 标识符形态。

```ts type-equiv
/** Nominal reference to one credential: a POSIX-style environment-variable name. */
type CredentialRef = Branded<'CredentialRef'>
```

## 解析

`ctx.credentials.resolve(ref)` 返回提供方当前的非空机密字符串，未配置时返回 `undefined`。消费方不跨操作缓存。该 seam 刻意不暴露变更、来源描述、枚举或变更事件契约；方法签名由生成的[服务目录](../cordis-catalog/services.md)负责。
