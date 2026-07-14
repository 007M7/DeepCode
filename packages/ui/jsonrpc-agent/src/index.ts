/**
 * The `dsh-jsonrpc-agent` app package IS its bin (see `./bin.ts`): config
 * discovery plus the process-level exit lifecycle around a booted
 * `cordis.yml`. This module deliberately exports nothing — unlike the
 * stdio/ACP app packages there is no composition plugin here, because the
 * serving face is the {@link @deepseek-ai/dsh-jsonrpc} plugin the external
 * config loads like any other entry (which plugins actually start is the
 * config's decision, the hard semantic of the SDK runtime; see
 * docs/rfc/implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md).
 *
 * @module @deepseek-ai/dsh-jsonrpc-agent
 */

export {}
