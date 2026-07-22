/**
 * Trajectory/Waterfall plugin, browser half: merges ConversationViewMap and
 * registers the two placeholder views. Pure consumer — no ctx service, no
 * Context declaration merge; the minimal-plugin exemplar. Contract:
 * api-contracts v3 section 8.
 */
import type { Context } from 'cordis'
import { TrajectoryStatsHeader, type TrajectoryChromeProps } from './TrajectoryStatsHeader.tsx'
import { TrajectoryView } from './TrajectoryView.tsx'
import { WaterfallView, type WaterfallExtraProps } from './WaterfallView.tsx'

export { deriveSpans, deriveSpanStats, type SpanStats, type TurnSpan } from './spans.ts'
export { TrajectoryStatsHeader, type TrajectoryChromeProps } from './TrajectoryStatsHeader.tsx'
export { TrajectoryView } from './TrajectoryView.tsx'
export { WaterfallView, type WaterfallExtraProps } from './WaterfallView.tsx'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationViewMap {
    // Per-view extension shapes merged through the map (view-ring design):
    // the stats header's chrome props ride both entries; the waterfall body
    // additionally takes its lane-density extra. P-III widens these.
    trajectory: { chromeProps: TrajectoryChromeProps }
    waterfall: { chromeProps: TrajectoryChromeProps; extraProps: WaterfallExtraProps }
  }
}

/** Required services (cordis fiber inject — the loader passes the whole export surface as an object plugin). */
export const inject = ['conversation']

/**
 * Client plugin body: register the trajectory and waterfall views. The
 * registrations are effects on this fiber (plugin unload removes both tabs).
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  // chrome.header on both views: the second chrome-attachment consumer
  // (chat's footer StatsLine is the first) — proves both mount points live.
  ctx.conversation.registerView({
    id: 'trajectory', label: 'Trajectory', order: 10,
    component: TrajectoryView, chrome: { header: TrajectoryStatsHeader },
  })
  ctx.conversation.registerView({
    id: 'waterfall', label: 'Waterfall', order: 20,
    component: WaterfallView, chrome: { header: TrajectoryStatsHeader },
  })
}
