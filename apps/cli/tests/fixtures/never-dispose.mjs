/** Test-only Cordis plugin whose disposer announces entry and never settles. */

/**
 * Register a disposer that keeps process shutdown pending until it is forced.
 * @param {import('cordis').Context} ctx - loader-mounted test plugin context.
 */
export function apply(ctx) {
  const keepAlive = setInterval(() => {}, 60_000)
  ctx.effect(() => async () => {
    clearInterval(keepAlive)
    process.stderr.write('dsh-test: never-dispose started\n')
    await new Promise(() => {})
  })
}
