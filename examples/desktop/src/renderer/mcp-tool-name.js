// pure helper for parsing MCP tool names emitted by
// the DSH MCP client (`packages/mcp/mcp-client/`). The kernel names public
// tools as `mcp__<serverName>__<rawName>`, with serverName drawn from the
// user-authored `dsh-mcp-client` config entry (1 config = 1 server). The
// tool-detail pane needs to (a) mark MCP-sourced tool calls in the row
// grammar with a `mcp · <serverName>` chip, and (b) surface the server
// attribution as its own row in the Attributes → Runtime group.
//
// The serverName grammar from the kernel: `[A-Za-z0-9_-]{1,32}`.
// The rawName may contain further `__` sequences (server-side tool names
// like `admin_reset_ab12cd34ef56`). We greedily consume the longest match
// for serverName that fits the grammar so the split is deterministic.
//
// Public API:
//   parseMcpToolName(name) → { server, rawName } | null
//     - Returns null when `name` isn't recognized as an MCP-emitted tool.
//     - `server` is the raw string as it appeared; grammar validation is
//       enforced by the regex.
//     - `rawName` is everything after the second `__` separator (may be
//       empty for pathological inputs, still returned as a string).

'use strict'

;(function () {
  // Anchor the whole match; server must be non-empty and fit the kernel
  // grammar; rawName is at least one character (empty rawName after the
  // second `__` is a kernel bug we don't try to speak-for).
  const MCP_TOOL_NAME_RE = /^mcp__([A-Za-z0-9_-]{1,32})__(.+)$/

  function parseMcpToolName(name) {
    if (typeof name !== 'string' || name.length === 0) return null
    const m = name.match(MCP_TOOL_NAME_RE)
    if (!m) return null
    return { server: m[1], rawName: m[2] }
  }

  // A convenience wrapper the detail pane uses to collect the set of MCP
  // servers referenced by a record's outputs. Runtime-attribute rows are
  // rendered as `mcp.server = <name>` when there is exactly one server; the
  // pane switches to a comma-joined value for multi-server records (a step
  // that dispatched to multiple MCP servers within one turn is legal — the
  // kernel merges tools from all mounted mcp-client instances).
  function collectMcpServers(outputs) {
    if (!Array.isArray(outputs)) return []
    const seen = new Set()
    for (const ev of outputs) {
      if (!ev || !ev.data) continue
      const tool = ev.data.tool || ev.data.name
      const parsed = parseMcpToolName(tool)
      if (parsed) seen.add(parsed.server)
      if (Array.isArray(ev.data.content)) {
        for (const block of ev.data.content) {
          if (block && block.type === 'tool_use') {
            const p = parseMcpToolName(block.name)
            if (p) seen.add(p.server)
          }
        }
      }
    }
    return Array.from(seen)
  }

  const API = { parseMcpToolName, collectMcpServers }
  if (typeof module !== 'undefined' && module.exports) module.exports = API
  if (typeof window !== 'undefined') window.__dshMcpToolName = API
})()
