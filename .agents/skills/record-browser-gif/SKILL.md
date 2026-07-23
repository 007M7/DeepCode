---
name: record-browser-gif
description: Record browser or Web UI interaction demos as optimized local GIFs using the available built-in browser, state-based frame capture, and deterministic encoding. Use when Codex is asked to make, record, or generate a GIF that demonstrates a browser workflow, including real-server or real-API behavior. Stop after returning the verified local artifact; do not upload it or edit a pull request.
---

# Record Browser GIF

Produce a short, truthful UI demonstration as a local GIF. Use the browser-control skill for interaction and the bundled encoder for repeatable timing, dimensions, and size.

## Keep the boundary explicit

- Produce frame images and one local `.gif` artifact only.
- Never upload the artifact, post a comment, or change a pull request, issue, or document under this skill. Hand those actions to a separate workflow if the user requests them.
- Preserve the requested provenance. A real-server or real-API demo must not use fixture queries, mock transports, synthetic event injection, or test-only hooks. If credentials or the server are unavailable, report that limitation instead of substituting a fixture.
- Never read or expose credential values. Use the application's normal configuration path and a benign demonstration prompt.

## Record the flow

1. Invoke the available browser-control skill and follow its setup, interaction, and cleanup instructions. Use the user's existing Chrome state only when requested or required.
2. Resolve the evidence boundary before recording: identify the exact origin, whether the app is built or in development, the transport, and any fixture or mock mode. Record only claims that the observed setup supports.
3. Choose three to six states that tell one story, such as initial, typed, submitted, and completed. Prefer semantic state changes over continuous capture; omit loading churn that does not help the viewer.
4. Keep one viewport and crop for every frame. Store frames in an absolute artifact directory outside the Git worktree unless the user requests another location, and name them lexically: `00-initial.png`, `01-typed.png`, and so on.
5. Before each screenshot, wait for a concrete UI condition such as a unique label, enabled control, changed document title, or completed response. Do not use a fixed delay as proof that the application reached the state.
6. Capture no secrets, personal data, unrelated tabs, or transient notifications. Stop any unnecessarily long real-API run after the demonstrated state is visible.

Use the browser's own screenshot API. When it returns image bytes, save those bytes directly; the encoder detects image content independently of the filename extension.

## Encode the GIF

Require `python3`, `ffmpeg`, and `ffprobe`. If either media binary is missing, report the dependency instead of installing software without authorization.

Set `GIF_SKILL_DIR` to this skill's absolute directory, then encode the lexically ordered frames:

```sh
python3 "$GIF_SKILL_DIR/scripts/encode_gif.py" \
  /absolute/path/to/frames \
  /absolute/path/to/demo.gif \
  --durations 1.5,1.5,1.5,3.5 \
  --fps 10 \
  --max-width 1200 \
  --colors 128
```

One duration applies to every frame; otherwise provide one comma-separated positive duration per frame. The encoder rejects fewer than two frames, mismatched dimensions or durations, invalid limits, accidental overwrite, unexpected duration, and output above `--max-bytes`.

For a large artifact, reduce `--max-width` first, then `--colors` or `--fps`; retain readable text and the final state long enough to inspect. Use `--force` only after resolving the exact output path.

## Verify and deliver

1. Read the encoder's JSON summary and confirm the output path, source and encoded frame counts, dimensions, duration, and byte size.
2. Inspect the first and final source frames and the resulting GIF. Confirm that the transition is legible, the last state is held long enough, and no sensitive content appears.
3. If capture occurred near a repository, run `git status --short` and confirm the artifact did not dirty the worktree.
4. Return the absolute GIF path, render it when the client supports local media, and state whether the recording used a real API, fixture, or another transport. Stop without uploading it or editing remote content.
