# apiproxy 协议 vs 仓内 dsh-jsonrpc 平视对比调研

任务：把 apiproxy 新设计的 RPC 协议与 `packages/ui/jsonrpc/`（JSON-RPC 2.0 over stdio，真实消费方为 python SDK）做六维平视对比，找双向学习点，不做契约修改。

## 文件索引

| 文件 | 内容 |
|---|---|
| `findings.md` | 六维对比表（信封/类型安全/错误/流/传输/生命周期，jsonrpc 侧全带 file:line）+ 建议采纳清单（1 条契约改动建议 + 3 条实现注记 + 1 条反面自查） |

## 进展

| 时间 | 事项 |
|---|---|
| 2026-07-19 20:39 | 读毕我方 design.md v1.2 + README 拍板表；细读 jsonrpc 三源文件 + README + transport 测试 + jsonrpc-demo bin + python SDK client.py（真实协议客户端） |
| 2026-07-19 20:46 | 第一批落盘：维度 1（帧/信封）+ 维度 2（类型安全） |
| 2026-07-19 20:52 | 第二批落盘：维度 3（错误模型）+ 维度 4（流/事件推送），发现子代理谱系学习点 |
| 2026-07-19 20:58 | 第三批落盘：维度 5（传输抽象）+ 维度 6（生命周期/取消）+ 建议采纳清单，调研完成 |
