/**
 * Connection plugin, node half. The package IS a dshClient plugin: the wire
 * consumer layer lives in its client half in full (src/client/ — contract:
 * api-contracts v3 section 3, inventory §3.2); consumers import the /client
 * subpath. The empty apply exists so the plugin appears in the host Loader
 * (lifecycle governance + dshClient discovery).
 */

/** Host plugin body — no host-side behavior for the connection plugin. */
export function apply(_ctx: unknown): void {}
