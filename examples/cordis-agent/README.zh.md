# cordis-agent

[English](README.md) | 中文

自指 harness 演示：在全屏 TUI 上运行 DeepSeek V4 编码主干，并加载 [`@deepseek-ai/dsh-tool-cordis`](../../packages/cordis/tool-cordis/README.md)。后者通过 agent（智能体）所在的 **实时 cordis 运行时** 向模型提供三个工具：检查运行时、将新插件挂载到其中，以及再次释放它们。`ctx.fs` 和 `ctx.web` 服务也会挂载（仅作为提供方，不包含面向模型的文件／Web 工具），使 agent 编写的插件可以构建于真实能力之上；Node 内置模块在沙箱中被截获并重定向到这些服务。设计（沙箱语义、挂载生命周期、跨挂载组合、注意事项）详见[工具集 Agent Note](../../.agents/notes/implemented/feature/2026-07-08-self-referential-cordis-toolset.md)。

## 运行

```sh
# repo root .env (gitignored) or exported env:
#   DEEPSEEK_API_KEY=sk-…
#   DEEPSEEK_BASE_URL=https://…   # optional; defaults to the public API
pnpm run demo:cordis
```

预期演示分阶段进行：先验证监听器链接，再让 agent 扩展自身：

```
> Mount a plugin that listens to the 'agent/status' event and logs every status change, then run `echo hi` with bash.
  [tool call] cordis_mount({"code": "return { name: 'status-logger', apply(ctx) { ctx.on('agent/status', (agent, status) => console.log('status →', status)) } }"})
  [tool result] mounted dyn-1 (plugin "status-logger", state: active)
  [tool call] bash({"command": "echo hi"})
[cordis:dyn-1] status → …            ← the mounted listener firing, live
> Now give yourself a reverse_text tool and use it on "harness".
  [tool call] cordis_mount({"code": "return { name: 'reverse-text', inject: ['tools'], apply(ctx) { ctx.tools.register(harness.defineTool({ name: 'reverse_text', … })) } }"})
  [tool call] reverse_text({"text": "harness"})   ← a tool the agent built for itself, one step earlier
> Unmount both.
  [tool call] cordis_unmount({"id": "dyn-1"})
```

请求 `cordis_inspect` 并使用 `what: "api"` 或 `what: "events"`，即可查看为 agent 生成、供其编写插件时参考的服务／事件资料。还可尝试两个协作挂载（一个中调用 `ctx.provide`，另一个中使用 `inject`），观察 cordis 如何暂停并恢复消费方。

## 端到端测试

`tests/keyless-smoke.e2e.ts` 使用虚拟密钥通过 Loader 启动真实 `cordis.yml`，并断言横幅、包名解析和 EOF 后干净退出。`tests/cordis-tools.e2e.ts` 是带密钥的冒烟测试：真实模型挂载状态监听器，测试验证其带标记的 console 行；然后创建并使用 `reverse_text` 工具，再通过 provide/inject 组合两个挂载。[`packages/cordis/tool-cordis`](../../packages/cordis/tool-cordis) 在每文件 100% 覆盖率门禁下承载单元覆盖。
