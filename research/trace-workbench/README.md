# DeepSeek Harness Trace Workbench

Localhost UI backed by real DeepSeek Harness persisted session JSONL files.

```sh
node server.js
```

Then open <http://127.0.0.1:5173/>.

Defaults:

- Reads sessions from `./.sessions` under the current working directory (set `HARNESS_SESSIONS_ROOT` to point elsewhere)
- Serves static UI and API from the same localhost origin
- Annotations are appended to `.feedback/*.jsonl` next to the server (local data, not committed)

Useful overrides:

```sh
HARNESS_SESSIONS_ROOT=/path/to/.sessions PORT=5174 node server.js
```

API:

- `GET /api/health`
- `GET /api/sessions`
- `GET /api/sessions/:id`

Current UI capabilities:

- Reads real session JSONL, not mock data; replay-only (the composer is disabled until live runtime wiring lands).
- Three first-class views; the inspector is second-level and belongs to Chat only:
  - **Chat** — markdown-rendered surface conversation; clicking a message opens the inspector as an inner column (paired Input/Output, metadata, feedback, Plain/JSON/JSONL/YAML formatting) that squeezes the conversation, never overlays it.
  - **Trajectory** — self-contained: a structure tree (turn → step, with durations, tool summaries and error dots) navigates a step-grouped event table; lifecycle events are absorbed into the tree and sticky group headers instead of appearing as rows. Expanded rows carry Copy JSON, inline annotations (标注) and the raw event.
  - **Waterfall** — hotspot finder: a summary strip (total / LLM time / tool time / errors / slowest step / tokens) plus an aligned time track; clicking any bar, label or stat jumps to the matching Trajectory row.
- Session list groups subagent sessions under their `parentSession`; a spawning tool call links to the sessions it spawned, and a child session shows a breadcrumb back to its parent.
- Failed tool calls are marked in every view (red rail + `← error` chip in Trajectory, red bar in Waterfall, `Tool failed` in Chat).
- Panes resize by dragging the dividers (clamped; widths persist), and all panes squeeze each other in one layer.
- URL carries `?session=&view=&sel=` so any selection is a shareable deep link.
