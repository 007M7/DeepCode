# InputBar bug 清单（2026-07-20，fixture 模式 playwright 探针 probe.mjs 实测 + 代码审读）

组件：`packages/client/web-ui/src/components/conversation/InputBar.tsx`；draft 逻辑：`packages/client/web-runtime/src/session/session.ts`（setDraft/sendDraft）+ `notifier.ts`（微任务批量通知）。

状态标记：✅ 探针实锤 / ⚠️ 代码审读潜伏（fixture 时延掩盖，真 host 必现或概率现）。

## B1 ✅ 中文 IME 组合期 Enter 误发送

- 复现：textarea 输入拼音进入候选组合态，按 Enter 选词。探针：dispatch `keydown Enter (isComposing=true, keyCode 229)` → 气泡 24→25，草稿被清空。
- 预期：组合期 Enter 只选词，不发送。
- 实际：直接发送并清稿——onKeyDown 未检查 `nativeEvent.isComposing`/`keyCode===229`。中文用户主路径必踩。

## B2 ✅ 中段编辑光标跳到末尾（控制组件异步回写）

- 复现：输入 `abcdef`，光标移到位置 3，敲 `x`。值正确变 `abcxdef` 但光标跳到 7（末尾）。
- 预期：光标停在 4。
- 实际根因：`setDraft` → `Notifier.markDirty` 走 **queueMicrotask** 异步通知 → onChange 当拍 re-render 时 value prop 还是旧值，React 把 DOM 回滚到旧值，微任务后再刷新值 → 光标丢失。受控输入外部 store 必须**同步**通知（React uSES 官方告诫场景）。末尾打字（P2b）不可见是因为光标本来就在末尾。

## B3 ✅ 长文本软换行不增高（rows 只数 \n）

- 复现：粘贴无换行长文本（8 倍长句）。rows=1、clientHeight=36 但 scrollHeight=75——内容被裁剪，需在 1 行高度里滚动。
- 预期：随内容自动增高至 6 行封顶，超出内部滚动。
- 实际：`rows={min(6, max(1, draft.split('\n').length))}` 只按换行符计行，软换行完全不感知。

## B4 ✅ 按钮发送后焦点丢失

- 复现：输入文字点「发送」按钮。activeElement 落在 BODY（按钮点击抢焦点，发送后无 refocus）。
- 预期：焦点回到 textarea，可直接继续打字。

## B5 ✅ 停止钮出现/消失引发按钮列布局跳动

- 复现：发送触发 running → 停止钮渲染出来，发送/插话按钮 y 从 642 跳到 606（整列上移 36px）。running 结束再跳回。
- 预期：按钮位置稳定（常驻占位或布局不受 running 影响）。

## B6 ✅ Enter 长按 autorepeat 重复发送

- 复现：探针同一 tick 内 dispatch 3 个 `repeat=true` 的 Enter keydown → 发出 3 条相同消息。物理长按 Enter 同理。
- 预期：长按只发一次。
- 实际：未检查 `e.repeat`；且 `empty` 来自 props（异步快照），同拍多个 keydown 全部通过检查。

## B7 ⚠️ 发送在途重复触发（B6 的一般形）

- fixture 的 prompt 近同步返回所以 P3（两次 press Enter）侥幸通过；真 host RPC 往返几十/几百 ms，窗口内第二次 Enter/双击发送钮会把同一草稿发两遍。
- 预期：同一草稿在途期间 sendDraft 幂等（在途锁）；accepted 之后的再次发送是合法排队，不受影响。
- 位置：`session.ts sendDraft` 无在途守卫。

## B8 ⚠️ 发送在途继续打字被 ok 清稿吞掉

- `sendDraft` ok 后无条件 `this.draft = ''`。真 host 在途窗口内用户新敲的字符会被整体清掉。
- 预期：ok 只清「发送时刻的那份草稿」——若 draft 已被用户改过则保留新内容（比对后再清）。
- fixture 下 P5 侥幸 OK（时延太短）。

## B9 ⚠️ 停止失败的错误文案错标为「发送失败」

- `session.cancel()` 失败把 error 写进 `promptError`，InputBar 错误条渲染固定文案「发送失败：…」。停止失败会显示成发送失败，误导。
- 位置：session.ts cancel + InputBar.tsx error 条。

## B10 INFO 切 session / 打开会话后无自动聚焦

- 切到会话后 activeElement 是列表按钮，需手动点 textarea 才能打字。deepseekchat 等聊天产品切会话即聚焦输入框。低危提升项，与 B4 一并处理（focus 管理统一）。

## 探针留档

- 脚本：`missions/tasks/20260720-0246-inputbar-fix/probe.mjs`（fixture 模式，可重跑）。
- 通过项（当前已正确）：P2b 快速输入不丢字、P3 慢速双 Enter（fixture 掩盖，见 B7）、P7 多行 \n 自增高封顶 6、P8 空白输入禁发、P9 切 session 草稿保持。
