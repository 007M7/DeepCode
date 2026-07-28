/**
 * Pure listing-presentation tests: display ordering and the model-facing
 * envelope, exercised without a context or provider.
 */

import { describe, expect, it } from 'vitest'
import { formatListOutput, orderEntries } from '../src/list-render.ts'
import type { ListedEntry } from '../src/list-render.ts'

const entry = (name: string, type: ListedEntry['type'] = 'file'): ListedEntry => ({ name, type })

describe('orderEntries', () => {
  it('groups directories, then files, then other, each by name', () => {
    const ordered = orderEntries([
      entry('zeta.txt'),
      entry('socket', 'other'),
      entry('beta'),
      entry('src', 'directory'),
      entry('assets', 'directory'),
    ])
    expect(ordered.map(e => e.name)).toEqual(['assets', 'src', 'beta', 'zeta.txt', 'socket'])
  })

  it('leaves the input array untouched and preserves extra entry fields', () => {
    const input = [{ name: 'b', type: 'file' as const, size: 2 }, { name: 'a', type: 'file' as const, size: 1 }]
    const ordered = orderEntries(input)
    expect(input.map(e => e.name)).toEqual(['b', 'a'])
    expect(ordered).toEqual([{ name: 'a', type: 'file', size: 1 }, { name: 'b', type: 'file', size: 2 }])
  })
})

describe('formatListOutput', () => {
  it('marks directories and non-regular children, and counts the whole listing', () => {
    expect(formatListOutput('/w', [entry('src', 'directory'), entry('a.txt'), entry('sock', 'other')], 10)).toBe(`<path>/w</path>
<type>directory</type>
<content>
src/
a.txt
sock@

(3 entries: 1 directory, 1 file, 1 other)
</content>`)
  })

  it('omits the "other" clause when every child is a file or a directory', () => {
    expect(formatListOutput('/w', [entry('a.txt'), entry('b.txt')], 10)).toContain('(2 entries: 0 directories, 2 files)')
  })

  it('says a one-entry listing in the singular', () => {
    expect(formatListOutput('/w', [entry('only', 'directory')], 10)).toContain('(1 entry: 1 directory, 0 files)')
  })

  it('states the complete size and composition when the view is capped', () => {
    const entries = [entry('src', 'directory'), ...Array.from({ length: 5 }, (_, i) => entry(`f${i}.txt`))]
    const rendered = formatListOutput('/w', entries, 2)
    expect(rendered).toContain('src/\nf0.txt\n')
    expect(rendered).not.toContain('f2.txt')
    expect(rendered).toContain('(Showing 2 of 6 entries: 1 directory, 5 files. '
      + 'Entries are directories first, then files, each alphabetical; list a subdirectory to see the rest.)')
  })

  it('renders an empty directory as a footer alone', () => {
    expect(formatListOutput('/w', [], 10)).toBe(`<path>/w</path>
<type>directory</type>
<content>
(Empty directory)
</content>`)
  })
})
