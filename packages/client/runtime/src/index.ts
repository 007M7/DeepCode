/**
 * Runtime plugin, node half. The implementation lives entirely in the client
 * half (src/client/ — SlotsService, SessionsService + object layer, and the
 * shell-held ClientLoader under ./loader); consumers import the /client or
 * /loader subpaths. The empty apply exists so the plugin appears in the host
 * Loader (lifecycle governance + dshClient discovery). Contract:
 * api-contracts v3 section 4.
 */

/** Host plugin body — no host-side behavior for the runtime plugin. */
export function apply(_ctx: unknown): void {}
