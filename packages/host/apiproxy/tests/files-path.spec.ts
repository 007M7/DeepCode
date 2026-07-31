/** The /f URL shape: one encoding decision, asserted from both ends. */
import { describe, expect, it } from 'vitest'
import {
  FILES_PATH, parseWorkspaceFilePath, workspaceFileSegments, workspaceFileUrl,
} from '../src/api/files.ts'

describe('workspaceFileSegments', () => {
  it('keeps a relative path as its own segments', () => {
    expect(workspaceFileSegments('/w', 'out/index.html')).toEqual(['out', 'index.html'])
    expect(workspaceFileSegments(undefined, 'index.html')).toEqual(['index.html'])
    expect(workspaceFileSegments('/w', './a/./b.txt')).toEqual(['a', 'b.txt'])
  })

  it('strips the cwd prefix from an absolute path inside the workspace', () => {
    expect(workspaceFileSegments('/w', '/w/a/b.html')).toEqual(['a', 'b.html'])
    // A trailing separator on the cwd must not shift the split.
    expect(workspaceFileSegments('/w/', '/w/a.html')).toEqual(['a.html'])
  })

  it('reads Windows paths on either separator', () => {
    expect(workspaceFileSegments('C:\\w', 'C:\\w\\a\\b.html')).toEqual(['a', 'b.html'])
    expect(workspaceFileSegments('C:/w', 'C:\\w\\a.html')).toEqual(['a.html'])
  })

  it('refuses everything the route would not serve', () => {
    // Absolute, but not under this workspace.
    expect(workspaceFileSegments('/w', '/etc/hosts')).toBeUndefined()
    // A sibling directory sharing the cwd's name prefix is not inside it.
    expect(workspaceFileSegments('/w', '/workspace-other/a')).toBeUndefined()
    // Absolute with no cwd to anchor against.
    expect(workspaceFileSegments(undefined, '/w/a.html')).toBeUndefined()
    expect(workspaceFileSegments('', '/w/a.html')).toBeUndefined()
    // Traversal, in either spelling.
    expect(workspaceFileSegments('/w', '../secret')).toBeUndefined()
    expect(workspaceFileSegments('/w', 'a/../../secret')).toBeUndefined()
    // The workspace directory itself is not a file.
    expect(workspaceFileSegments('/w', '/w')).toBeUndefined()
    expect(workspaceFileSegments('/w', '.')).toBeUndefined()
  })
})

describe('workspaceFileUrl', () => {
  it('percent-encodes each segment but keeps the separators structural', () => {
    expect(workspaceFileUrl('s-1', ['out', 'a b.html'])).toBe(`${FILES_PATH}/s-1/out/a%20b.html`)
    expect(workspaceFileUrl('s/1', ['a#b.html'])).toBe(`${FILES_PATH}/s%2F1/a%23b.html`)
  })
})

describe('parseWorkspaceFilePath', () => {
  it('round-trips what the browser half builds', () => {
    const url = workspaceFileUrl('s-1', ['out', 'a b.html'])
    expect(parseWorkspaceFilePath(url)).toEqual({ sessionId: 's-1', segments: ['out', 'a b.html'] })
  })

  it('refuses malformed, prefix-foreign, and traversal pathnames', () => {
    expect(parseWorkspaceFilePath('/api/session.list')).toBeUndefined()
    expect(parseWorkspaceFilePath(FILES_PATH)).toBeUndefined()
    // Session named but no file below it.
    expect(parseWorkspaceFilePath(`${FILES_PATH}/s-1`)).toBeUndefined()
    expect(parseWorkspaceFilePath(`${FILES_PATH}//a.html`)).toBeUndefined()
    // Traversal is refused at parse time, before any filesystem call.
    expect(parseWorkspaceFilePath(`${FILES_PATH}/s-1/../etc/hosts`)).toBeUndefined()
    expect(parseWorkspaceFilePath(`${FILES_PATH}/s-1/a/./b`)).toBeUndefined()
    expect(parseWorkspaceFilePath(`${FILES_PATH}/s-1/a//b`)).toBeUndefined()
    // A separator smuggled through percent-encoding stays one segment's problem.
    expect(parseWorkspaceFilePath(`${FILES_PATH}/s-1/a%2F..%2Fb`)).toBeUndefined()
    expect(parseWorkspaceFilePath(`${FILES_PATH}/s-1/a%5Cb`)).toBeUndefined()
    expect(parseWorkspaceFilePath(`${FILES_PATH}/s-1/a%00b`)).toBeUndefined()
    // Malformed percent-escapes are uninterpretable, not a miss to resolve.
    expect(parseWorkspaceFilePath(`${FILES_PATH}/s-1/a%zz`)).toBeUndefined()
    expect(parseWorkspaceFilePath(`${FILES_PATH}/%zz/a.html`)).toBeUndefined()
    expect(parseWorkspaceFilePath(`${FILES_PATH}//`)).toBeUndefined()
  })
})
