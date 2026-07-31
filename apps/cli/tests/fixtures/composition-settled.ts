import type { Context } from 'cordis'

/**
 * Marker the shipped-composition smoke gates its first prompt on. The TUI renders as soon as
 * its own fiber starts, so a prompt typed at the banner can reach the loop while
 * later rows — tool plugins, persistence — are still activating, and would
 * assemble a partial catalog. Waiting for this line makes the turn observe the
 * settled tree.
 */
export const COMPOSITION_SETTLED_MARKER = 'COMPOSITION_TREE_SETTLED'

export const name = 'composition-settled'

/**
 * Announce settled Loader activation on the terminal byte stream, after every
 * entry in the booted tree has started. The write is detached: awaiting the
 * Loader from inside an entry would wait on this entry's own activation.
 * @param ctx - the loader-mounted plugin context.
 */
export function apply(ctx: Context): void {
  void ctx.loader.await().then(() => {
    process.stdout.write(`\n${COMPOSITION_SETTLED_MARKER}\n`)
  })
}
