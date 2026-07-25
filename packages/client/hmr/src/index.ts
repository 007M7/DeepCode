/**
 * HMR plugin, node half. The package IS a dshClient plugin (dev-only row in
 * the host graph): the reload driver lives in its client half in full
 * (src/client/); the empty apply exists so the plugin appears in the host
 * Loader (lifecycle governance + dshClient discovery).
 */

/** Host plugin body — no host-side behavior for the HMR plugin. */
export function apply(): void {}
