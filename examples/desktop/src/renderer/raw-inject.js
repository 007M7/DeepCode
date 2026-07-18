// raw-inject.js — envelope:'raw' classifier.
//
// The kernel added an `envelope?: 'context'|'raw'` field plus a `meta?:
// JsonValue` slot on context/message events (packages/core/session/src/
// types.ts:239-251, audited 2026-07-17 against deepseek-harness-dev @
// fa2065872). When envelope==='raw' the caller owns the complete
// model-facing frame — the kernel does NOT wrap the content in a
// <context> tag.
//
// The current known raw producer is `workspace-context` plugin, which
// injects instructions with meta={ kind: 'workspace-instructions',
// version, changes[] } (grep across the kernel plugins/ tree, no other
// producer emits `envelope:'raw'` as of 07-17).
//
// This module is a pure classifier: given a context/message event, decide
// (a) is it raw?  (b) if so, what typed shape does meta advertise? Anything
// beyond `workspace-instructions` bucketises to an "unknown-kind raw"
// generic card so a future plugin's raw injection doesn't disappear.
//
// The tagged (envelope==='context' or absent) path is untouched; renderer.js
// only calls into this classifier when envelope==='raw'.

'use strict'

const RAW_KINDS = {
  'workspace-instructions': {
    key: 'workspace-instructions',
    label: 'workspace instructions',
    // Renderer keys these fields against the CSS surface in style.css §7.
    tone: 'raw',
    icon: '¶',
    // Meta shape we know how to render: { version, changes: [{ path, ... }] }.
    // See packages/plugins/workspace-context/src/index.ts audit @ fa2065872.
    shape: 'workspace-instructions',
  },
}

const DEFAULT_RAW_KIND = {
  key: null,
  label: 'unframed',
  tone: 'raw',
  icon: '¶',
  shape: 'generic',
}

// True when this event carries the raw envelope. Cheap enough that the
// dispatcher calls it before any other classification path.
function isRawContextEvent(event) {
  if (!event || typeof event !== 'object') return false
  if (event.type !== 'context/message') return false
  const data = event.data || event
  return data && data.envelope === 'raw'
}

// Return the typed meta record. `kind` is the meta.kind string when the
// meta object has one; anything else falls back to DEFAULT_RAW_KIND so the
// card still renders (never silently drop a raw injection — zero-loss is
// the wire seat contract).
function classifyRawInject(event) {
  if (!isRawContextEvent(event)) return null
  const data = event.data || event
  const meta = data && data.meta && typeof data.meta === 'object' ? data.meta : null
  const kind = meta && typeof meta.kind === 'string' ? meta.kind : null
  const shape = kind && Object.prototype.hasOwnProperty.call(RAW_KINDS, kind)
    ? RAW_KINDS[kind]
    : DEFAULT_RAW_KIND
  return {
    envelope: 'raw',
    kind: kind || null,
    meta: meta,
    shape,
    source: data.source || null,
  }
}

// Extract the shortlist a workspace-instructions card renders: version
// scalar + changes list. Defensive against missing / malformed fields —
// a partial meta still yields a card.
function workspaceInstructionsSummary(meta) {
  if (!meta || typeof meta !== 'object') return { version: null, changes: [] }
  const version = meta.version != null ? String(meta.version) : null
  const changes = Array.isArray(meta.changes)
    ? meta.changes.filter(c => c && typeof c === 'object').map((c) => ({
        path: typeof c.path === 'string' ? c.path : '',
        action: typeof c.action === 'string' ? c.action : null,
      }))
    : []
  return { version, changes }
}

const rawInjectApi = {
  isRawContextEvent,
  classifyRawInject,
  workspaceInstructionsSummary,
  RAW_KINDS,
  DEFAULT_RAW_KIND,
}

if (typeof module !== 'undefined' && module.exports) module.exports = rawInjectApi
if (typeof window !== 'undefined') window.__dshRawInject = rawInjectApi
