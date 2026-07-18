// Recover the kernel's SessionForkError.code from a wire-flattened message.
//
// packages/ui/jsonrpc/src/transport.ts turns any handler exception into a
// bare `-32603 { message }` on the wire — the SessionForkError.code field
// (OPEN_TURN, INVALID_BOUNDARY, SESSION_NOT_LIVE, SESSION_NOT_FOUND,
// SESSION_ALREADY_EXISTS) doesn't survive that flattening. The kernel's
// throw sites in packages/core/session/src/index.ts each use a distinct
// phrase that does survive, so we recover the code by pattern-matching
// those phrases. The renderer has a symmetric classifier
// (`classifyForkError` in src/renderer/renderer.js) that reads the same
// phrases so a message can be classified at either end of the IPC and
// they always agree.
//
// Returns the code string when a message maps to a known throw site;
// returns `null` when the message doesn't match anything, which is main.js's
// signal to fall through to the mock fallback (session/fork wasn't served
// at all, or the transport itself failed).

'use strict'

function classifyForkErrorMessage(msg) {
  if (typeof msg !== 'string' || msg.length === 0) return null
  if (/must be turn\/end/.test(msg)) return 'OPEN_TURN'
  if (/must be a non-negative safe integer/.test(msg)) return 'INVALID_BOUNDARY'
  if (/does not exist in session/.test(msg)) return 'INVALID_BOUNDARY'
  if (/does not match a contiguous event seq/.test(msg)) return 'INVALID_BOUNDARY'
  if (/is not the live store instance/.test(msg)) return 'SESSION_NOT_LIVE'
  if (/session ".+" not found/.test(msg)) return 'SESSION_NOT_FOUND'
  if (/already exists/.test(msg)) return 'SESSION_ALREADY_EXISTS'
  return null
}

module.exports = { classifyForkErrorMessage }
