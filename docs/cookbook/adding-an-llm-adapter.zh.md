# 实操手册：添加 LLM 适配器

[English](adding-an-llm-adapter.md) | 中文

如何接入一个新的模型提供方。参考实现：`packages/llm/llm-deepseek`（手写 HTTP/SSE）与 `packages/llm/llm-pi-ai`（封装 LLM 库）。请先阅读 `packages/llm/llm/src/types.ts` 中的 `StreamChunk` 文档——它记录了两个适配器都经过验证的协议约定。

## 基本形态

```ts ignore-check
class MyAdapter extends LlmAdapter {
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> { … }
}

export const name = 'llm-myprovider'
export const inject = ['llm']
export const Config: z<Config> = z.object({ apiKey: z.string(), … })

export function apply(ctx: Context, config: Config) {
  ctx.llm.registerAdapter(['model-a', 'model-b'], new MyAdapter(…))
}
```

注册基于副作用（HMR 安全）；每个模型名称对应一个适配器，重复注册会抛出异常。密钥采用 Cordis 原生方式管理：schemastery Config 带环境变量回退，通过 cordis.yml 的 `!!js process.env.MY_KEY` 注入。代码中禁止临时读取密钥文件。

## 协议义务（两个实现共同验证的契约）

- 在 `finish` **之前**发出 `usage`；`finish` 之后**不再发出任何内容**。稳健做法：缓冲 finish/usage 直到提供方的流结束标记，再统一 flush（可处理提供方在末尾发送仅含 usage 的分片的情况）。
- 工具调用的 `arguments` 全程为原始 JSON 字符串；流式片段以 `argumentsDelta` 发送。如果你的提供方返回已解析的对象，请在 `block-end` 时重新 stringify。
- 按首次出现的流顺序分配块 `index`；同一个块的每次 delta 复用该 index。
- 错误有且仅有两条合法路径：从 `stream()` **抛出**（传输与协议故障——使用带稳定 code 的 `LlmError`），或以 `finish {kind: 'error' | 'aborted'}` 结束流（提供方带内故障）。消费方两者都处理；按故障类别选择路径并加以文档化。
- 遵守 `options.signal`（将其传递给 fetch 或你的 SDK）。
- 如果 `GenerateOptions` 中某个字段你的提供方无法支持（例如提供方不支持 stop sequences 时收到 `stop` 列表）：抛出 `LlmError(..., 'UNSUPPORTED')`，而非静默丢弃。

提供方特有的请求旋钮（thinking 模式、effort 级别）放在**适配器**的 Config 中，而非 `GenerateOptions` 中——核心词汇保持提供方无关。

## 经验证有效的结构

将适配器拆分为可测试的阶段（llm-deepseek 的布局）：协议格式（wire format）类型（`types.ts`，豁免覆盖率）→ 请求序列化器 → SSE/传输解析器 → 分片转换状态机 → 一个将它们串联的薄适配器类。每个阶段配备独立的单元测试套件。

## 测试

- **单元测试：mock 提供方，而非 harness。** 用脚本化的 `node:http` 服务器模拟提供方的协议格式，覆盖正常路径、所有错误状态码、畸形载荷、连接提前关闭和中止——无需网络，且能满足 100% 逐文件覆盖率门禁。对基于 SDK 的适配器同样适用（将 SDK 的 baseURL 指向 mock 服务器）。
- **恶意分帧测试。** 在任意字节位置（包括 UTF-8 字符中间）切割流载荷——真实网络环境正是如此。
- **E2E：`tests/*.e2e.ts`**，通过 `pnpm run test:e2e` 运行，以 `describe.skipIf(!process.env.MY_KEY)` 守卫，确保无密钥的 CI 保持绿色。覆盖你映射的每个模型 × 每种提供方模式（thinking 开/关、effort 级别）、一次包含后续轮次（历史中带工具结果）的工具调用往返，以及仅做宽松断言（子串/结构匹配、有界的 maxTokens——真实模型是非确定性的）。
- 在 `knip.json` 中注册 e2e 文件模式（per-workspace `entry` 覆盖），否则 knip 会将其标记为未使用。
