/**
 * Pure listing-presentation tests: display ordering and the model-facing
 * envelope, exercised without a context or provider.
 */

import { describe, expect, it } from 'vitest'
import { countEntries, formatListOutput, orderEntries } from '../src/list-render.ts'
import type { ListedEntry, ListPage } from '../src/list-render.ts'

const entry = (name: string, type: ListedEntry['type'] = 'file'): ListedEntry => ({ name, type })

function page(entries: ListedEntry[], options: { offset?: number; totalEntries?: number; all?: ListedEntry[] } = {}): ListPage {
  const all = options.all ?? entries
  return {
    path: '/w',
    offset: options.offset ?? 1,
    entries,
    totalEntries: options.totalEntries ?? all.length,
    counts: countEntries(all),
  }
}

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
    expect(formatListOutput(page([entry('src', 'directory'), entry('a.txt'), entry('sock', 'other')]))).toBe(`<path>/w</path>
<type>directory</type>
<content>
src/
a.txt
sock@

(3 entries: 1 directory, 1 file, 1 other)
</content>`)
  })

  it('omits the "other" clause when every child is a file or a directory', () => {
    expect(formatListOutput(page([entry('a.txt'), entry('b.txt')]))).toContain('(2 entries: 0 directories, 2 files)')
  })

  it('says a one-entry listing in the singular', () => {
    expect(formatListOutput(page([entry('only', 'directory')]))).toContain('(1 entry: 1 directory, 0 files)')
  })

  it('states the complete size and composition when the view is capped', () => {
    const entries = [entry('src', 'directory'), ...Array.from({ length: 5 }, (_, i) => entry(`f${i}.txt`))]
    const rendered = formatListOutput(page(entries.slice(0, 2), { totalEntries: entries.length, all: entries }))
    expect(rendered).toContain('src/\nf0.txt\n')
    expect(rendered).not.toContain('f2.txt')
    expect(rendered).toContain('(Showing entries 1-2 of 6: 1 directory, 5 files. Use offset=3 to continue.)')
  })

  it('renders an empty directory as a footer alone', () => {
    expect(formatListOutput(page([]))).toBe(`<path>/w</path>
<type>directory</type>
<content>
(Empty directory)
</content>`)
  })
})
