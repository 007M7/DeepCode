// DetailsPanel, P-I minimal form: close button + the selected call's args and
// result rendered raw. The three-段 Switch / Prev-Next stepping / See-in-
// trajectory are deferred (ledger). Subscribes to the per-scope selection and
// derives the call material from the session snapshot — no data of its own.

import type { ConversationSnapshot, ToolResultNode } from '@deepseek-ai/dsh-client-runtime/client'
import { shallowEqual } from '@deepseek-ai/dsh-client-web-react'
import type { DetailsSlotProps } from '../contract/slots.ts'
import css from './DetailsPanel.module.css'

/** Full props composed by reference from the contract (owner & standard & injected shares). */
export type DetailsPanelProps = DetailsSlotProps

/** Selected call material: resolved result node, or the in-flight running call's args. */
interface CallMaterial {
  name: string
  argsRaw: string | null
  result: ToolResultNode | null
  running: boolean
}

function materialFor(s: ConversationSnapshot, callId: string): CallMaterial | null {
  for (const node of s.nodes) {
    if (node.kind === 'tool-result' && node.callId === callId) {
      return { name: node.call?.name ?? callId, argsRaw: node.call?.argsRaw ?? null, result: node, running: false }
    }
  }
  const open = s.runningCalls.find(c => c.callId === callId)
  if (open !== undefined) {
    return { name: open.name, argsRaw: open.argsRaw, result: null, running: true }
  }
  return null
}

function pretty(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    // Not JSON (streaming fragment or plain text): show verbatim.
    return raw
  }
}

export function DetailsPanel({ useSession, useSelection, actions }: DetailsPanelProps) {
  const selection = useSelection(s => s)
  const callId = selection?.callId
  // materialFor builds a fresh wrapper; shallowEqual short-circuits on its
  // stable members (result node reference rides the snapshot's structural sharing).
  const material = useSession(
    s => (callId === undefined ? null : materialFor(s as ConversationSnapshot, callId)),
    (a, b) => shallowEqual(a, b))

  return (
    <div className={css.root}>
      <div className={css.header}>
        <div className={css.title}>
          {selection === null ? '详情' : material?.name ?? selection.toolName ?? '详情'}
        </div>
        <button
          type="button" className={css.close} aria-label="关闭详情"
          onClick={() => { actions.closeDetails() }}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <div className={css.body}>
        {selection === null || callId === undefined
          ? <div className={css.empty}>点击消息流中的工具行查看详情</div>
          : material === null
            ? <div className={css.empty}>该调用不在当前窗口内</div>
            : (
                <>
                  {material.argsRaw !== null && (
                    <section className={css.section}>
                      <div className={css.sectionLabel}>Input</div>
                      <pre className={css.code}>{pretty(material.argsRaw)}</pre>
                    </section>
                  )}
                  <section className={css.section}>
                    <div className={css.sectionLabel}>Output</div>
                    {/* materialFor invariant: result===null ⇔ running (a settled
                        material always carries its result node). */}
                    {material.result === null
                      ? <div className={css.empty}>运行中…</div>
                      : (
                          <pre className={css.code} data-error={material.result.isError || undefined}>
                            {renderResult(material.result)}
                          </pre>
                        )}
                  </section>
                </>
              )}
      </div>
    </div>
  )
}

/** Flatten result content blocks to display text (text blocks verbatim, others as JSON). */
function renderResult(node: ToolResultNode): string {
  const parts: string[] = []
  for (const block of node.content) {
    if (block.type === 'text') parts.push(block.text)
    else parts.push(JSON.stringify(block, null, 2))
  }
  if (parts.length === 0 && node.error !== undefined) {
    parts.push(`${node.error.name}: ${node.error.code}`)
  }
  return parts.join('\n')
}
