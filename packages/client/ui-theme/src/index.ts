/**
 * Theme plugin, node half. Pure UI plugin: the empty apply exists so the
 * plugin appears in the host cordis.yml / Loader (load and lifecycle follow
 * the host; the browser half ships via exports["./client"], discovered
 * through the package.json dshClient declaration). ThemeService and its
 * types live in the client half; consumers import the /client subpath.
 * Contract: api-contracts v3 section 8.
 */

/** Host plugin body — no host-side behavior for the theme plugin. */
export function apply(): void {}
