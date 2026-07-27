import { describe, expect, it } from 'vitest'
import { renderUnknownXml } from '../src/components/xml-tool-output.ts'

const render = (source: string, limit = 4, expanded = false): string[] | undefined => renderUnknownXml(
  source,
  limit,
  expanded,
  text => text.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/gu, control =>
    `\\x${control.charCodeAt(0).toString(16).padStart(2, '0')}`),
  text => `[label]${text}[/label]`,
  count => `  … +${count} lines`,
)

describe('unknown-tool XML rendering', () => {
  it('renders nested elements and attributes as an indented tree', () => {
    expect(render(`<result>
  <path>/tmp/a.txt</path>
  <type>file</type>
  <content>
    <line number="1">hello</line>
    <line number="2">world</line>
  </content>
</result>`)).toEqual([
      '[label]result[/label]',
      '  [label]path:[/label] /tmp/a.txt',
      '  [label]type:[/label] file',
      '  [label]content[/label]',
      '    [label]line (number="1"):[/label] hello',
      '    [label]line (number="2"):[/label] world',
    ])
  })

  it('renders root text, CDATA, empty elements, and multiline nested text', () => {
    expect(render('  <result>\nfirst\nsecond\n</result>  ')).toEqual([
      '[label]result[/label]',
      '  first',
      '  second',
    ])
    expect(render('<result>\nfirst\nsecond\n</result>', 1, true)).toEqual([
      '[label]result[/label]',
      '  first',
      '  second',
    ])
    expect(render('<result><value><![CDATA[literal <xml>]]></value><empty /></result>')).toEqual([
      '[label]result[/label]',
      '  [label]value:[/label] literal <xml>',
      '  [label]empty[/label]',
    ])
  })

  it('previews each top-level child independently and expands all rows', () => {
    const xml = '<result><first>\na\nb\nc\nd\ne\nf\n</first><second>\ng\nh\ni\nj\nk\nl\n</second></result>'
    expect(render(xml, 3)).toEqual([
      '[label]result[/label]',
      '  [label]first[/label]',
      '    a',
      '  … +4 lines',
      '    f',
      '  [label]second[/label]',
      '    g',
      '  … +4 lines',
      '    l',
    ])
    expect(render(xml, 3, true)).toHaveLength(15)
  })

  it('bounds the collapsed child count and counts the hidden lines', () => {
    const xml = `<result>${Array.from({ length: 8 }, (_, index) => `<item>${index}</item>`).join('')}</result>`
    expect(render(xml, 3)).toEqual([
      '[label]result[/label]',
      '  [label]item:[/label] 0',
      '  [label]item:[/label] 1',
      '  … +5 lines',
      '  [label]item:[/label] 7',
    ])
    expect(render(xml, 3, true)).toHaveLength(9)
  })

  it('escapes control characters expanded from character references', () => {
    expect(render('<result attr="a&#155;b">tab&#9;csi&#155;</result>')).toEqual([
      '[label]result (attr="a\\\\x9bb")[/label]',
      '  tab\\x09csi\\x9b',
    ])
    expect(render('<result><value><![CDATA[del\u007f]]></value></result>')).toEqual([
      '[label]result[/label]',
      '  [label]value:[/label] del\\x7f',
    ])
  })

  it.each([
    '<result><path>missing close</result>',
    '<first /><second />',
    '<result />  <![CDATA[trailing]]>',
    'prefix <result><path>/tmp/a</path></result>',
    '<result><path>/tmp/a</path></result> suffix',
    '<?xml version="1.0"?><result />',
    '<result><?target value?></result>',
    '<!DOCTYPE result><result />',
    '<result><!-- comment --></result>',
    '',
    '   \n  ',
  ])('declines malformed or mixed text: %s', (source) => {
    expect(render(source)).toBeUndefined()
  })
})
