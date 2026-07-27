# cordis-agent

[English](README.md) | 中文

自指 harness 演示：在全屏 TUI 上运行 DeepSeek V4 编码主干，并加载 [`@deepseek-ai/dsh-tool-cordis`](../../packages/cordis/tool-cordis/README.md)。后者让模型检查当前 DSH 进程、挂载仅存于内存的临时 Plugin，并再次卸载它们。临时 Plugin 可跨 turn 保持活跃，但会在卸载、工具集卸载或 DSH 重启后消失；它们不创建文件或配置，也可能影响同一进程中的其他 session。`ctx.fs` 和 `ctx.web` 是这些 Plugin 可用的 provider-only 能力。设计详见[工具集 Agent Note](../../.agents/notes/implemented/feature/2026-07-08-self-referential-cordis-toolset.md)。

## 运行

```sh
# repo root .env (gitignored) or exported env:
#   DEEPSEEK_API_KEY=sk-…
#   DEEPSEEK_BASE_URL=https://…   # optional; defaults to the public API
pnpm run demo:cordis      # TUI (default)
pnpm run demo:cordis web  # browser UI at http://127.0.0.1:3081
pnpm run demo:cordis acp  # ACP server
```

预期演示分阶段进行：先验证监听器链接，再让 agent 扩展自身：

```
> Mount a temporary Plugin that listens to the 'agent/status' event and logs every status change, then run `echo hi` with bash.
  [tool call] cordis_mount({"code": "return { name: 'status-logger', apply(ctx) { ctx.on('agent/status', (agent, status) => console.log('status →', status)) } }"})
  [tool result] Temporary Plugin dyn-1 is running (plugin "status-logger"; available until unmounted or DSH restarts).
  [tool call] bash({"command": "echo hi"})
[cordis:dyn-1] status → …            ← the temporary listener firing, live
> Now give yourself a reverse_text tool and use it on "harness".
  [tool call] cordis_mount({"code": "return { name: 'reverse-text', inject: ['tools'], apply(ctx) { ctx.tools.register(harness.defineTool({ name: 'reverse_text', … })) } }"})
  [tool call] reverse_text({"text": "harness"})   ← a tool the agent built for itself, one step earlier
> Unmount both temporary Plugins.
  [tool call] cordis_unmount({"id": "dyn-1"})
```

请求 `cordis_inspect` 并使用 `what: "api"` 或 `what: "events"`，即可查看编写 Plugin 代码所用的生成服务／事件资料。还可挂载两个协作临时 Plugin（一个中调用 `ctx.provide`，另一个中使用 `inject`），观察 Cordis 如何暂停并恢复消费方。

## 端到端测试

`tests/keyless-smoke.e2e.ts` 使用虚拟密钥通过 Loader 启动真实 `cordis.yml`，并断言横幅、包名解析和 EOF 后干净退出。`tests/cordis-tools.e2e.ts` 是带密钥的冒烟测试：真实模型挂载一个临时状态 listener，测试验证其带标记的 console 行；然后创建并使用 `reverse_text` 工具，再通过 provide/inject 组合两个临时 Plugin。[`packages/cordis/tool-cordis`](../../packages/cordis/tool-cordis) 在每文件 100% 覆盖率门禁下承载单元覆盖。
