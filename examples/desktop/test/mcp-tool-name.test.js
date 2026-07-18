'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const M = require('../src/renderer/mcp-tool-name.js')

test('parseMcpToolName: matches standard mcp__server__tool shape', () => {
  const parsed = M.parseMcpToolName('mcp__github__create_issue')
  assert.deepEqual(parsed, { server: 'github', rawName: 'create_issue' })
})

test('parseMcpToolName: preserves further __ inside rawName', () => {
  // Kernel emits `admin_reset_<12 hex>` for hash-fallback names; the
  // hex disambiguator is part of rawName, not another server split.
  const parsed = M.parseMcpToolName('mcp__srv__admin_reset_0123456789ab')
  assert.deepEqual(parsed, { server: 'srv', rawName: 'admin_reset_0123456789ab' })
})

test('parseMcpToolName: server may contain dashes and digits', () => {
  const parsed = M.parseMcpToolName('mcp__grafana-mcp-42__query')
  assert.deepEqual(parsed, { server: 'grafana-mcp-42', rawName: 'query' })
})

test('parseMcpToolName: rejects non-mcp tool names', () => {
  assert.equal(M.parseMcpToolName('read_file'), null)
  assert.equal(M.parseMcpToolName('mcp_client_tool'), null)
})

test('parseMcpToolName: rejects malformed prefix', () => {
  assert.equal(M.parseMcpToolName('mcp__server_no_double_underscore'), null)
})

test('parseMcpToolName: rejects server exceeding 32 char kernel budget', () => {
  const long = 'a'.repeat(33)
  assert.equal(M.parseMcpToolName(`mcp__${long}__tool`), null)
})

test('parseMcpToolName: rejects empty rawName', () => {
  assert.equal(M.parseMcpToolName('mcp__server__'), null)
})

test('parseMcpToolName: null/undefined/non-string safe', () => {
  assert.equal(M.parseMcpToolName(null), null)
  assert.equal(M.parseMcpToolName(undefined), null)
  assert.equal(M.parseMcpToolName(123), null)
  assert.equal(M.parseMcpToolName(''), null)
})

test('collectMcpServers: dedupes and sorts entries pulled from tool/call events', () => {
  const outputs = [
    { type: 'tool/call', data: { tool: 'mcp__github__create_issue' } },
    { type: 'tool/call', data: { tool: 'read_file' } }, // native, ignored
    { type: 'tool/call', data: { tool: 'mcp__github__list_repos' } },
    { type: 'tool/call', data: { tool: 'mcp__everything__get_sum' } },
  ]
  const servers = M.collectMcpServers(outputs).sort()
  assert.deepEqual(servers, ['everything', 'github'])
})

test('collectMcpServers: also inspects assistant tool_use blocks', () => {
  const outputs = [
    {
      type: 'assistant/message',
      data: {
        content: [
          { type: 'text', text: 'calling' },
          { type: 'tool_use', name: 'mcp__grafana__query', id: 'call_1' },
        ],
      },
    },
  ]
  const servers = M.collectMcpServers(outputs)
  assert.deepEqual(servers, ['grafana'])
})

test('collectMcpServers: gracefully handles bad shapes', () => {
  assert.deepEqual(M.collectMcpServers(null), [])
  assert.deepEqual(M.collectMcpServers([null, undefined, {}]), [])
  assert.deepEqual(M.collectMcpServers([{ type: 'tool/call' }]), [])
})
