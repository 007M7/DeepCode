// View-ring type-chain samples (design §9 item 5, views half): the
// register→inject→render chain composed through ConversationViewMap's
// per-view extension shapes, plus expect-error duals for each stage.
// Follows the slots-ring exemplar (ui-slots/tests/type-chain.spec.tsx):
// negatives live in a never-executed function body; the positive dual runs
// the real ConversationService view registry.
import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import type { FC, ReactNode } from 'react'
import type {
  ChromePropsOf, ConvViewProps, ConvViewPropsOf, ViewEntry,
} from '../src/client/contract/views.ts'
import { ConversationService } from '../src/client/service.ts'

// Test-only view keys with distinct extension shapes (merged like
// ui-trajectory does; extension fields are optional per ViewEntryDef).
declare module '../src/client/contract/views.ts' {
  interface ConversationViewMap {
    'vt-extended': { chromeProps: { statLabel: string }; extraProps: { density: 'compact' | 'wide' } }
    'vt-plain': object
  }
}

const ExtendedView: FC<ConvViewPropsOf<'vt-extended'>> = ({ density }) => (density === 'compact' ? null : null)
const ExtendedChrome: FC<ChromePropsOf<'vt-extended'>> = ({ statLabel }) => (statLabel === '' ? null : null)
const PlainView: FC<ConvViewPropsOf<'vt-plain'>> = () => null

describe('view-ring type-chain negatives (compile-time; body never runs)', () => {
  it('holds the negative samples as expect-error sites', () => {
    const negatives = (service: ConversationService) => {
      // 1. Registration: a component missing the entry's declared extraProps
      //    cannot register under that id (props flow from the map entry).
      const NarrowComp: FC<ConvViewProps & { density: number }> = () => null
      service.registerView({
        id: 'vt-extended',
        label: 'x',
        // @ts-expect-error density has the wrong value type vs the map entry's extraProps
        component: NarrowComp,
      })
      // 2. Registration: chrome typed for another view's chromeProps drifts.
      service.registerView({
        id: 'vt-plain',
        label: 'x',
        component: PlainView,
        // @ts-expect-error vt-plain declares no statLabel chromeProps
        chrome: { footer: ExtendedChrome },
      })
      // 3. Registration: id outside the map is rejected at the entry.
      service.registerView({
        // @ts-expect-error unregistered view id
        id: 'vt-ghost',
        label: 'x',
        component: PlainView,
      })
      // 4. Render side: per-view props narrow — the extended view's density
      //    is not accessible under another id's props type.
      const renderPlain = (props: ConvViewPropsOf<'vt-plain'>): ReactNode => {
        // @ts-expect-error density belongs to vt-extended's extension, not vt-plain
        return props.density === 'compact' ? null : null
      }
      void renderPlain
      // 5. Entry-shape drift: ViewEntry<Id> ties chrome and component to the
      //    SAME id — mixing ids inside one entry fails.
      const mixed: ViewEntry<'vt-extended'> = {
        id: 'vt-extended',
        label: 'x',
        component: ExtendedView,
        // @ts-expect-error chrome for vt-plain cannot ride a vt-extended entry
        chrome: { header: (props: ChromePropsOf<'vt-plain'> & { onlyPlain: true }) => null },
      }
      void mixed
      // 6. Zero-renderSlot inference: the view ring declares no children, so
      //    view props carry no delegation face (the old hand-written
      //    ScopedSlots<never> empty surface is retired, not replaced).
      const renderless = (props: ConvViewPropsOf<'vt-plain'>): ReactNode => {
        // @ts-expect-error views receive no renderSlot — no sub-slot delegation
        void props.renderSlot
        // @ts-expect-error the legacy slots face is gone from view props
        void props.slots
        return null
      }
      void renderless
      return null as ReactNode
    }
    expect(negatives).toBeTypeOf('function')
  })
})

describe('view-ring full chain (positive dual)', () => {
  it('registers, lists, and renders through the per-view extension shapes', () => {
    const ctx = new Context()
    const service = new ConversationService(ctx)
    // Registration: extension-typed component + same-id chrome compose cleanly.
    const dispose = service.registerView({
      id: 'vt-extended',
      label: '扩展视图',
      order: 7,
      component: ExtendedView,
      chrome: { footer: ExtendedChrome },
    })
    const entry = service.views().find(v => v.id === 'vt-extended')
    expect(entry?.label).toBe('扩展视图')
    // Render surface: the listed entry's component accepts the composed props
    // (base ConvViewProps + the map extension), spelled here as the same type
    // the runtime hands over.
    expect(typeof entry?.component).toBe('function')
    expect(typeof entry?.chrome?.footer).toBe('function')
    dispose()
    expect(service.views().some(v => v.id === 'vt-extended')).toBe(false)
  })
})
