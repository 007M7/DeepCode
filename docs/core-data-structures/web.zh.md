# Web 访问

[English](web.md) | 中文

Web 访问 seam 是一个[能力 seam](../rfc/implemented/architecture/2026-06-24-web-capability-seam.md)，在单一 `ctx.web` 服务上横跨**两种能力**（搜索与抓取），拆分到多个包（package）中：接口（[dsh-web](../../packages/web/web)，`ctx.web` + 提供方注册表）、实现（[dsh-web-search-exa](../../packages/web/web-search-exa)、[dsh-web-search-perplexity](../../packages/web/web-search-perplexity)、[dsh-web-search-deepseek](../../packages/web/web-search-deepseek)、[dsh-web-fetch-local](../../packages/web/web-fetch-local)），以及消费方（[dsh-tool-web](../../packages/web/tool-web)，`web_search`/`web_fetch` 工具 schema）。Web 是**一项可选能力**，不属于 agent loop 主干，因此其词汇定义在此，而非 [core.md](core.md)。更换搜索提供方不会改变模型发起查询的方式，更换抓取实现也不会改变模型请求 URL 的方式。

源码：[`packages/web/web/src/types.ts`](../../packages/web/web/src/types.ts)

## 为何两种能力共用一个 seam

搜索与抓取既不共享请求 schema，也不共享业务逻辑，但它们被有意设计为同一个 `ctx.web` 中间层：一个提供方选择策略的归属者、一套 abort/error 词汇、一个面向产品的「此 harness 如何访问 Web」配置界面。代价是服务上出现了并行的 `searchX`/`fetchX` 方法对；这种并行是有意为之，而非遗漏的提取。提供方注册的是**能力**（`WebSearchProvider` 或 `WebFetchProvider`），而非工具；面向模型的名称、schema、prompt 引导与展示全部集中在唯一的消费方 `dsh-tool-web` 中。

## 搜索请求与结果

面向模型的工具参数仅为一个 `query`；`maxResults` 是消费方持有的上限（`dsh-tool-web` 的 `searchMaxResults` 配置，默认 `8`），通过 seam 传递并在返回时强制执行：如果提供方返回的结果超量，seam 会截断 `sources[]` 并设置 `truncated`。

```ts type-equiv
interface WebSearchRequest {
  readonly query: string
  /**
   * Upper bound on returned sources; the seam truncates to it. Omitted = no
   * bound. `dsh-tool-web` always sets it.
   */
  readonly maxResults?: number
}
```

```ts type-equiv
interface WebSearchResult {
  readonly content?: string
  readonly sources: readonly WebSearchSource[]
  readonly truncated: boolean
}
```

`content` 是提供方可选生成的回答文本（Exa 和 DeepSeek 不返回；Perplexity 返回生成式回答）。`sources[]` 是可移植的引用界面。每条 source 必有 `url`；`title`/`snippet`/`publishedAt` 可选，因为并非所有提供方都返回它们：Perplexity 的引用可能只有 URL，强迫适配器编造其余字段会让 seam 说谎。`dsh-tool-web` 渲染时使用 `title ?? hostname(url)`。

```ts type-equiv
interface WebSearchSource {
  readonly url: string
  readonly title?: string
  readonly snippet?: string
  readonly publishedAt?: string
}
```

## 抓取请求与结果

```ts type-equiv
interface WebFetchRequest {
  readonly url: string
}
```

HTTP 状态码是被抓取资源状态的一部分，不自动视为失败：成功的网络抓取返回 `404`/`500` 时，结果仍是一个带状态码和有界解码 body 的 `WebFetchResult`。`url` 是经过允许的重定向后的最终 URL。`WebError` 保留给无法安全获取或表示资源的失败情形。

```ts type-equiv
interface WebFetchResult {
  readonly url: string
  readonly statusCode: number
  readonly body: WebFetchBody
  readonly truncated: boolean
}
```

`WebFetchBody` 是 `dsh-web` 持有的**封闭**可辨识联合类型（不是可合并扩展的 map）：提供方解码 kind，`dsh-tool-web` 渲染它，因此新增一个 kind 是跨已知包的协调变更，而非插件扩展。消费方对 `kind` 做 `switch` 并以 `default: assertNever(...)` 结尾，因此新增 kind 会在每个消费方处破坏编译直到被处理。即使当前各分支字段相同，每个分支仍保持独立的对象字面量，为将来的分支特有字段留出空间（例如未来 `pdf` body 的 `pageCount`）。

```ts type-equiv
type WebFetchBody =
  | { readonly kind: 'html'; readonly content: string }
  | { readonly kind: 'text'; readonly content: string }
```

## 提供方可用性

提供方的 `available(): boolean` 是一个廉价的**本地**检查（凭证是否存在、配置是否可解析），**禁止发起网络调用**。它是执行时选择的输入，而非健康检查系统：`search()`/`fetch()` 读取它来选出可用的提供方，选择失败以结构化的 `WebError` 呈现给调用方路由，其 code 和 message 携带可分支的细节（缺失的 id 或歧义的候选集）。

选择从不依赖注册顺序、配置顺序或 HMR 顺序：一项能力要么有显式的提供方 id（配置 `searchProvider`/`fetchProvider`，或喂入同一字段的对应环境变量），要么在恰好只有一个可用提供方注册时自动选择；多个可用提供方且未配置 id 时为 `WEB_PROVIDER_AMBIGUOUS`，而非先注册先赢。

## 错误

`WebError extends HarnessError`（[core.md](core.md) 错误分类体系），带有 `code: string`（开放式，与其他 seam 的错误一致：`LlmError`、`SubagentError`），而非封闭联合类型：提供方可以在不修改 `dsh-web` 的情况下抛出自己的 code，消费方必须容忍未知 code。code 按归属者划分。seam 中性的 code 由 `WebService` 选择逻辑和共享契约抛出：`WEB_PROVIDER_UNAVAILABLE`、`WEB_PROVIDER_CONFIGURED_MISSING`、`WEB_PROVIDER_CONFIGURED_UNAVAILABLE`、`WEB_PROVIDER_AMBIGUOUS`、`WEB_DUPLICATE_PROVIDER`（注册时的编程错误，类似 `LlmService` 的 `DUPLICATE_ADAPTER`）、`WEB_ABORTED`，以及 `WEB_PROVIDER_ERROR`（提供方自身失败通过 seam 暴露的兜底 code，包括网络/传输失败：DNS、连接被拒、TLS）。抓取传输层 code 由 `dsh-web-fetch-local` 实现持有，不同的抓取后端不必抛出它们：`WEB_INVALID_URL`、`WEB_BLOCKED_URL`、`WEB_REDIRECT_BLOCKED`、`WEB_FETCH_TOO_LARGE`、`WEB_FETCH_TIMEOUT`、`WEB_UNSUPPORTED_CONTENT_TYPE`。

## 服务

`WebService` 注册搜索与抓取提供方，以 `WEB_DUPLICATE_PROVIDER` 拒绝重复 id，并在执行时以结构化的选择错误解析提供方。本地抓取后端仅接受 HTTP(S)、拒绝凭证、限制重定向次数、字节数、字符数与时间、对每一跳同源重定向重新校验，并解码 body；展示由工具负责。私有网络阻断尚未实现，因此不要在能触及敏感内部目标的环境中启用 `web_fetch`。
