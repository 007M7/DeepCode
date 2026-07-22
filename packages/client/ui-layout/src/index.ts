/**
 * Layout plugin, node half. Pure UI plugin: the empty apply exists so the
 * plugin appears in the host cordis.yml / Loader (load and lifecycle follow
 * the host; the browser half ships via exports["./client"], discovered
 * through the package.json dshClient declaration). Contract: api-contracts
 * v3 sections 0.3 and 5.
 */

/** Host plugin body — no host-side behavior for the layout plugin. */
export function apply(): void {}
