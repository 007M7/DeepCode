// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Schema from 'schemastery'
import { SchemaForm } from '../src/index.ts'

afterEach(cleanup)

const Wire = (schema: Schema): unknown => JSON.parse(JSON.stringify(schema.toJSON()))

const Profile = Schema.object({
  apiKey: Schema.string().role('secret'),
  apiKeyEnv: Schema.string().role('credential-ref'),
  baseURL: Schema.string().description('Endpoint override'),
  reasoning: Schema.union(['off', 'high', 'max']),
  timeoutMs: Schema.number().min(0).max(1000).step(1),
  verbose: Schema.boolean(),
  name: Schema.string().required(),
})

function lastDraft(onChange: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return onChange.mock.calls.at(-1)?.[0] as Record<string, unknown>
}

describe('leaf controls', () => {
  it('renders strings with inherited placeholders, writes on input, clears on empty', () => {
    const onChange = vi.fn()
    render(<SchemaForm
      schema={Wire(Profile)}
      draft={{ baseURL: 'https://mine' }}
      fallback={{ baseURL: 'https://base', reasoning: 'high' }}
      onChange={onChange}
    />)
    const input = screen.getByDisplayValue('https://mine')
    fireEvent.change(input, { target: { value: 'https://next' } })
    expect(lastDraft(onChange)).toEqual({ baseURL: 'https://next' })
    fireEvent.change(input, { target: { value: '' } })
    expect(lastDraft(onChange)).toEqual({})
    const inherited = screen.getByPlaceholderText('Default: https://base')
    expect(inherited).toBeTruthy()
  })

  it('renders numbers with bounds and parses edits', () => {
    const onChange = vi.fn()
    const { container } = render(<SchemaForm
      schema={Wire(Profile)}
      draft={{}}
      fallback={{ timeoutMs: 500 }}
      onChange={onChange}
    />)
    const input = container.querySelector('input[type="number"]') as HTMLInputElement
    expect(input.placeholder).toBe('Default: 500')
    expect(input.min).toBe('0')
    expect(input.max).toBe('1000')
    fireEvent.change(input, { target: { value: '250' } })
    expect(lastDraft(onChange)).toEqual({ timeoutMs: 250 })
  })

  it('clears a number override back to inherited on empty input', () => {
    const onChange = vi.fn()
    const { container } = render(<SchemaForm
      schema={Wire(Profile)}
      draft={{ timeoutMs: 250 }}
      onChange={onChange}
    />)
    const input = container.querySelector('input[type="number"]') as HTMLInputElement
    expect(input.value).toBe('250')
    fireEvent.change(input, { target: { value: '' } })
    expect(lastDraft(onChange)).toEqual({})
  })

  it('prefers an overridden boolean over the fallback', () => {
    const { container } = render(<SchemaForm
      schema={Wire(Profile)}
      draft={{ verbose: false }}
      fallback={{ verbose: true }}
      onChange={vi.fn()}
    />)
    const box = container.querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(box.checked).toBe(false)
  })

  it('reflects booleans from the fallback until overridden', () => {
    const onChange = vi.fn()
    const { container } = render(<SchemaForm
      schema={Wire(Profile)}
      draft={{}}
      fallback={{ verbose: true }}
      onChange={onChange}
    />)
    const box = container.querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(box.checked).toBe(true)
    fireEvent.click(box)
    expect(lastDraft(onChange)).toEqual({ verbose: false })
  })

  it('renders literal unions as selects with an inherit option', () => {
    const onChange = vi.fn()
    const { container } = render(<SchemaForm
      schema={Wire(Profile)}
      draft={{}}
      fallback={{ reasoning: 'high' }}
      onChange={onChange}
    />)
    const select = container.querySelector('select') as HTMLSelectElement
    expect([...select.options].map(option => option.text)).toEqual(['Default: high', 'off', 'high', 'max'])
    fireEvent.change(select, { target: { value: 'max' } })
    expect(lastDraft(onChange)).toEqual({ reasoning: 'max' })
  })

  it('clears a union override back to inherit', () => {
    const onChange = vi.fn()
    const { container } = render(<SchemaForm
      schema={Wire(Profile)}
      draft={{ reasoning: 'max' }}
      onChange={onChange}
    />)
    const select = container.querySelector('select') as HTMLSelectElement
    expect(select.value).toBe('max')
    fireEvent.change(select, { target: { value: '' } })
    expect(lastDraft(onChange)).toEqual({})
  })

  it('marks required fields and surfaces descriptions', () => {
    render(<SchemaForm schema={Wire(Profile)} draft={{}} onChange={vi.fn()} />)
    expect(screen.getByText('Endpoint override')).toBeTruthy()
    expect(screen.getByText('name').textContent).toContain('name')
    expect(screen.getByText('*')).toBeTruthy()
  })

  it('shows the per-field reset only for overridden fields and deletes on click', () => {
    const onChange = vi.fn()
    render(<SchemaForm
      schema={Wire(Profile)}
      draft={{ baseURL: 'https://mine' }}
      onChange={onChange}
    />)
    const resets = screen.getAllByText('Reset')
    expect(resets).toHaveLength(1)
    fireEvent.click(resets[0] as HTMLElement)
    expect(lastDraft(onChange)).toEqual({})
  })
})

describe('secrets and custom renderers', () => {
  it('renders secrets write-only with the stored-state placeholder', () => {
    const onChange = vi.fn()
    const { container } = render(<SchemaForm
      schema={Wire(Profile)}
      draft={{}}
      secrets={[{ path: ['apiKey'], set: true }]}
      onChange={onChange}
    />)
    const input = container.querySelector('input[type="password"]') as HTMLInputElement
    expect(input.placeholder).toBe('Configured — enter a new value to replace')
    expect(input.value).toBe('')
    fireEvent.change(input, { target: { value: 'sk-new' } })
    expect(lastDraft(onChange)).toEqual({ apiKey: 'sk-new' })
  })

  it('clears a typed-but-unsaved secret back to unset', () => {
    const onChange = vi.fn()
    const { container } = render(<SchemaForm
      schema={Wire(Profile)}
      draft={{ apiKey: 'sk-draft' }}
      onChange={onChange}
    />)
    const input = container.querySelector('input[type="password"]') as HTMLInputElement
    expect(input.value).toBe('sk-draft')
    fireEvent.change(input, { target: { value: '' } })
    expect(lastDraft(onChange)).toEqual({})
  })

  it('reports an unset secret slot', () => {
    const { container } = render(<SchemaForm
      schema={Wire(Profile)}
      draft={{}}
      secrets={[{ path: ['apiKey'], set: false }]}
      onChange={vi.fn()}
    />)
    const input = container.querySelector('input[type="password"]') as HTMLInputElement
    expect(input.placeholder).toBe('Not configured')
  })

  it('lets renderField replace a role-tagged control', () => {
    render(<SchemaForm
      schema={Wire(Profile)}
      draft={{ apiKeyEnv: 'OPENAI_API_KEY' }}
      onChange={vi.fn()}
      renderField={(context) => {
        if (context.role !== 'credential-ref') return undefined
        return <div data-testid="credential-control">{String(context.draftValue)}</div>
      }}
    />)
    expect(screen.getByTestId('credential-control').textContent).toBe('OPENAI_API_KEY')
  })

  it('disables every control under disabled', () => {
    const { container } = render(<SchemaForm
      schema={Wire(Profile)}
      draft={{}}
      disabled
      onChange={vi.fn()}
    />)
    for (const input of container.querySelectorAll('input, select, button')) {
      expect((input as HTMLInputElement).disabled).toBe(true)
    }
  })
})

describe('containers', () => {
  const Catalog = Schema.object({
    models: Schema.array(Schema.object({ id: Schema.string().required() })),
    retryPolicy: Schema.object({ maxRetries: Schema.number() }),
  })

  it('renders nested object groups', () => {
    render(<SchemaForm schema={Wire(Catalog)} draft={{}} onChange={vi.fn()} />)
    expect(screen.getByText('retryPolicy')).toBeTruthy()
    expect(screen.getByText('maxRetries')).toBeTruthy()
  })

  it('materializes fallback rows into the draft on add and edit', () => {
    const onChange = vi.fn()
    render(<SchemaForm
      schema={Wire(Catalog)}
      draft={{}}
      fallback={{ models: [{ id: 'flash' }] }}
      onChange={onChange}
    />)
    fireEvent.click(screen.getByText('Add'))
    expect(lastDraft(onChange)).toEqual({ models: [{ id: 'flash' }, {}] })
    fireEvent.change(screen.getByPlaceholderText('Default: flash'), { target: { value: 'pro' } })
    expect(lastDraft(onChange)).toEqual({ models: [{ id: 'pro' }] })
  })

  it('removes draft array rows wholesale', () => {
    const onChange = vi.fn()
    render(<SchemaForm
      schema={Wire(Catalog)}
      draft={{ models: [{ id: 'flash' }, { id: 'pro' }] }}
      onChange={onChange}
    />)
    fireEvent.click(screen.getAllByText('Remove')[0] as HTMLElement)
    expect(lastDraft(onChange)).toEqual({ models: [{ id: 'pro' }] })
  })

  it('renders dict rows from both layers with removal only for draft keys', () => {
    const Providers = Schema.object({ providers: Schema.dict(Schema.object({ baseURL: Schema.string() })) })
    const onChange = vi.fn()
    render(<SchemaForm
      schema={Wire(Providers)}
      draft={{ providers: { openai: { baseURL: 'https://o' } } }}
      fallback={{ providers: { anthropic: { baseURL: 'https://a' }, openai: { baseURL: 'https://o' } } }}
      onChange={onChange}
    />)
    expect(screen.getByText('anthropic')).toBeTruthy()
    expect(screen.getByText('openai')).toBeTruthy()
    const removes = screen.getAllByText<HTMLButtonElement>('Remove')
    expect(removes.map(button => button.disabled)).toEqual([true, false])
    fireEvent.click(removes[1] as HTMLElement)
    expect(lastDraft(onChange)).toEqual({ providers: {} })
  })

  it('adds dict entries through a free-text key input', () => {
    const Providers = Schema.object({ providers: Schema.dict(Schema.object({ baseURL: Schema.string() })) })
    const onChange = vi.fn()
    render(<SchemaForm schema={Wire(Providers)} draft={{}} onChange={onChange} />)
    const add = screen.getByLabelText<HTMLInputElement>('Add')
    fireEvent.keyDown(add, { key: 'a' })
    expect(onChange).not.toHaveBeenCalled()
    add.value = 'openai'
    fireEvent.keyDown(add, { key: 'Enter' })
    expect(lastDraft(onChange)).toEqual({ providers: { openai: {} } })
    add.value = ''
    fireEvent.keyDown(add, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('offers remaining sKey vocabulary as the add select', () => {
    const Providers = Schema.object({
      providers: Schema.dict(Schema.object({ baseURL: Schema.string() }), Schema.union(['openai', 'anthropic'])),
    })
    const onChange = vi.fn()
    render(<SchemaForm
      schema={Wire(Providers)}
      draft={{ providers: { openai: {} } }}
      onChange={onChange}
    />)
    const add = screen.getByLabelText<HTMLSelectElement>('Add')
    expect([...add.options].map(option => option.value)).toEqual(['', 'anthropic'])
    fireEvent.change(add, { target: { value: 'anthropic' } })
    expect(lastDraft(onChange)).toEqual({ providers: { openai: {}, anthropic: {} } })
  })

  it('materializes type-shaped empty values for every array inner kind', () => {
    const Kinds = Schema.object({
      tags: Schema.array(Schema.string()),
      nums: Schema.array(Schema.number()),
      flags: Schema.array(Schema.boolean()),
      lists: Schema.array(Schema.array(Schema.string())),
      dicts: Schema.array(Schema.dict(Schema.string())),
    })
    const onChange = vi.fn()
    render(<SchemaForm schema={Wire(Kinds)} draft={{}} onChange={onChange} />)
    const adds = screen.getAllByText('Add')
    const expected: Record<string, unknown> = {
      tags: [''], nums: [0], flags: [false], lists: [[]], dicts: [{}],
    }
    Object.entries(expected).forEach(([key, value], index) => {
      fireEvent.click(adds[index] as HTMLElement)
      expect(lastDraft(onChange)).toEqual({ [key]: value })
    })
  })

  it('falls back to a read-only view for unsupported nodes instead of dropping them', () => {
    const Mixed = Schema.object({ weird: Schema.union([Schema.string(), Schema.number()]) })
    render(<SchemaForm
      schema={Wire(Mixed)}
      draft={{}}
      fallback={{ weird: 42 }}
      onChange={vi.fn()}
    />)
    expect(screen.getByText('42')).toBeTruthy()
    expect(screen.getByText(/no form control/)).toBeTruthy()
  })

  it('shows the draft value in the read-only fallback view, and nothing when both layers are empty', () => {
    const Mixed = Schema.object({ weird: Schema.union([Schema.string(), Schema.number()]) })
    const { container } = render(<SchemaForm
      schema={Wire(Mixed)}
      draft={{ weird: 'overridden' }}
      onChange={vi.fn()}
    />)
    expect(screen.getByText('"overridden"')).toBeTruthy()
    cleanup()
    const empty = render(<SchemaForm schema={Wire(Mixed)} draft={{}} onChange={vi.fn()} />).container
    expect((empty.querySelector('pre') as HTMLElement).textContent).toBe('')
    expect(container).toBeTruthy()
  })

  it('renders a structural object node without declared properties as an empty group', () => {
    const { container } = render(<SchemaForm schema={{ type: 'object' }} draft={{}} onChange={vi.fn()} />)
    expect(container.querySelectorAll('input')).toHaveLength(0)
  })
})
