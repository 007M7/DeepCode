import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { assistantText, contentBlocks, contentText, reasoningText } from '../src/renderer-content.ts'

describe('desktop live content', () => {
  it('renders single ACP update blocks before the persisted message exists', () => {
    expect(contentText({ type: 'text', text: '你' })).toBe('你')
    expect(contentText({ type: 'reasoning', text: '想' })).toBe('想')
  })

  it('accepts plain strings, arrays, and empty values', () => {
    const blocks = [{ type: 'text', text: 'a' }]
    expect(contentBlocks(blocks)).toBe(blocks)
    expect(contentBlocks(null)).toEqual([])
    expect(contentText('plain')).toBe('plain')
    expect(assistantText('plain')).toBe('plain')
  })

  it('keeps persisted content arrays split by visible role', () => {
    const content = [
      { type: 'reasoning', text: '先想' },
      { type: 'text', text: '再答' },
    ]
    expect(reasoningText(content)).toBe('先想')
    expect(assistantText(content)).toBe('再答')
  })

  it('renders tool, resource, and unknown blocks without object coercion', () => {
    expect(contentText({ type: 'tool-call', name: 'bash', arguments: { command: 'pwd' } }))
      .toBe('[tool-call bash] {"command":"pwd"}')
    expect(contentText({ type: 'resource_link', name: 'notes', uri: 'file:///notes' }))
      .toBe('[resource notes] file:///notes')
    expect(contentText({ type: 'custom', value: 1 })).toBe('{"type":"custom","value":1}')
    expect(contentText({ type: 'text', text: 1 })).toBe('')
    expect(contentText({ type: 'tool-call', name: 1, arguments: 'pwd' })).toBe('[tool-call ] pwd')
    expect(contentText({ type: 'tool-call', name: 'bash' })).toBe('[tool-call bash] ')
    expect(contentText({ type: 'resource_link' })).toBe('[resource ] ')
    expect(reasoningText([{ type: 'reasoning', text: 1 }])).toBe('')
    expect(contentText(undefined)).toBe('')
  })
})

describe('desktop shell layout', () => {
  it('pins the docks and composer to their explicit bottom rows', async () => {
    const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.session-canvas,\s*\.module-canvas\s*{\s*grid-row: 3;/)
    // Every dock needs an explicit row: auto placement once floated the queue
    // to the top of the main pane.
    expect(css).toMatch(/#interactionDock\s*{\s*grid-row: 4;/)
    expect(css).toMatch(/#queueDock\s*{\s*grid-row: 5;/)
    expect(css).toMatch(/#planDock\s*{\s*grid-row: 6;/)
    expect(css).toMatch(/\.composer\s*{\s*grid-row: 7;/)
  })

  it('does not launch Electron after a strict-port Vite failure', async () => {
    const script = await readFile(new URL('../scripts/dev.mjs', import.meta.url), 'utf8')
    expect(script).toContain("'--strictPort'")
    expect(script).not.toContain('setTimeout(startElectron')
  })

  it('suppresses persisted ACP replay updates before forwarding a new prompt', async () => {
    const main = await readFile(new URL('../src/main.mjs', import.meta.url), 'utf8')
    expect(main).toContain('replayingSessions.has(String(params.sessionId))')
    expect(main).toContain('replayingSessions.add(sessionId)')
    expect(main).toContain('replayingSessions.delete(sessionId)')
  })

  it('switches from Develop to Sessions and patches artifact detail in place', async () => {
    const app = await readFile(new URL('../src/app.ts', import.meta.url), 'utf8')
    expect(app).toMatch(/if \(sessionButton !== null\) \{\s*showModule\('sessions'\)\s*await loadTrace/)
    expect(app).toContain("selectDevArtifact(devArtifact.dataset.devArtifact ?? '')")
    expect(app).toContain('detail.innerHTML = renderDevArtifactDetail(selected)')
  })
})
