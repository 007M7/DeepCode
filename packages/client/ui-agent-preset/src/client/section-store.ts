/**
 * Agent-preset management controller: the roster as a list, and one
 * composition open in the editor at a time.
 *
 * The host stays the single fact source. Every mutation writes through the
 * wire and the page re-reads the roster afterwards, because a save can change
 * more than the row it targeted — creating a preset adds one, and the shape
 * check the host applies is what decides whether the text landed at all.
 */

import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { beginRosterRead, messageOf, writeDefaultPreset } from './settings-store.ts'

/** Ids a preset directory may be named, mirroring the host's own rule. */
const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/

/** One preset row the page renders. */
export interface PresetRow {
  /** Preset id and directory name; the display name falls back to it. */
  id: string
  /** Display name the preset published, absent when it published none. */
  name?: string
  /** One sentence on what the preset is for. */
  description?: string
  /** Whether the preset ships with the deployment or was authored locally. */
  trust: 'system' | 'user'
  /** Whether a session that names no preset gets this one. */
  isDefault: boolean
}

/** The composition currently open in the editor. */
export interface PresetDraft {
  /** Preset the draft saves to; empty until a new one is named. */
  id: string
  /**
   * The preset the text came from, shown while a new preset is unnamed so
   * the editor can say what it is a copy of. Absent on a preset started
   * blank, which is a copy of nothing.
   */
  source?: string
  /** Whether saving creates a preset rather than replacing one. */
  creating: boolean
  /** Composition text being edited. */
  content: string
  /** Whether this draft can be saved at all — a shipped preset opens read-only. */
  writable: boolean
  /** Whether a save is in flight. */
  saving: boolean
  /** Display name being edited; empty means the picker falls back to the id. */
  name: string
  /** Description being edited. */
  description: string
  /** The last save failure, cleared by the next edit. */
  error: string | null
}

/** Page snapshot. */
export interface AgentPresetSectionState {
  status: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'
  /** Whole-load failure text; a save failure stays on the draft. */
  error: string | null
  /** Whether the deployment configures a root new presets can be written to. */
  authorable: boolean
  /** Every preset the deployment currently supplies. */
  rows: readonly PresetRow[]
  /** The open editor, or null when the page is just the list. */
  draft: PresetDraft | null
  /** The preset awaiting delete confirmation. */
  pendingDelete: string | null
  /** Whether a delete is in flight. */
  deleting: boolean
}

const INITIAL: AgentPresetSectionState = {
  status: 'idle',
  error: null,
  authorable: false,
  rows: [],
  draft: null,
  pendingDelete: null,
  deleting: false,
}

/**
 * Why this draft cannot be saved yet, as a locale key, or undefined when it
 * can. Client-side only: the host re-checks both the id and the composition
 * shape, and its answer is what the editor reports on failure.
 * @param draft - the open draft.
 * @param rows - the roster, for the collision check.
 * @returns the blocking reason's locale key, or undefined when saveable.
 */
export function draftBlocker(
  draft: PresetDraft,
  rows: readonly PresetRow[],
): 'idRequired' | 'idInvalid' | 'idTaken' | undefined {
  if (!draft.creating) return undefined
  if (draft.id === '') return 'idRequired'
  if (!PRESET_ID.test(draft.id)) return 'idInvalid'
  // Replacing an existing preset is what Edit is for; a create that lands on
  // a name already in use would overwrite something the user did not open.
  if (rows.some(row => row.id === draft.id)) return 'idTaken'
  return undefined
}

/** Reads the roster and drives the composition editor. */
export class AgentPresetSectionController {
  /** Page snapshot the renderer subscribes to. */
  readonly store: SnapshotStore<AgentPresetSectionState> = createSnapshotStore(INITIAL)

  constructor(
    private readonly api: Pick<IApiClient, 'agentPresets' | 'settings'>,
    /**
     * Called after this page changes the roster DIRECTORY, so the other
     * surfaces reading the same roster re-read it. A settings field moving is
     * already announced by the host through `settings/changed`; a file written
     * or deleted here is not, and the new-session chip has no other way to
     * learn a preset it should offer now exists.
     */
    private readonly rosterChanged: () => void = () => {},
  ) {}

  private set(patch: Partial<AgentPresetSectionState>): void {
    this.store.set({ ...this.store.getSnapshot(), ...patch })
  }

  private patchDraft(patch: Partial<PresetDraft>): void {
    const { draft } = this.store.getSnapshot()
    if (draft === null) return
    this.set({ draft: { ...draft, ...patch } })
  }

  /**
   * Load the roster. An empty roster means the deployment composes no
   * presets, which is a valid deployment rather than a failure — the section
   * reports `unavailable` and renders nothing.
   * @returns once the snapshot reflects the host.
   */
  async load(): Promise<void> {
    const roster = await beginRosterRead(
      this.api, () => this.store.getSnapshot().status, patch => { this.set(patch) },
    )
    if (roster === undefined) return
    const { presets, authorable } = roster
    if (presets.length === 0) {
      this.set({ status: 'unavailable', rows: [], authorable, draft: null })
      return
    }
    this.set({ status: 'ready', error: null, authorable, rows: presets.map(preset => ({ ...preset })) })
  }

  /**
   * Open one preset's composition in the editor.
   *
   * A shipped preset opens read-only rather than not opening: it is the
   * known-good composition a local one is written against, so being able to
   * read it is the point.
   * @param id - the preset to open.
   * @returns once the composition loaded or the failure is on the page.
   */
  async open(id: string): Promise<void> {
    await this.openDraft(id, false)
  }

  /**
   * Open a new, unnamed preset. With no argument it starts blank; copying is
   * its own action, offered on the row being copied, so the two arrive at the
   * same editor by the route the author actually chose. Starting from some
   * preset nobody named would put text in the editor that the author has to
   * recognise as unwanted before deleting it.
   * @param from - the preset to copy, or undefined to start blank.
   * @returns once the composition loaded or the failure is on the page.
   */
  async createFrom(from?: string): Promise<void> {
    if (from === undefined) {
      this.set({
        error: null,
        draft: {
          id: '',
          creating: true,
          content: '',
          writable: true,
          name: '',
          description: '',
          saving: false,
          error: null,
        },
      })
      return
    }
    await this.openDraft(from, true)
  }

  private async openDraft(source: string, creating: boolean): Promise<void> {
    this.set({ error: null })
    try {
      const response = await this.api.agentPresets.read({ agentPreset: source })
      if (!response.result.ok) {
        this.set({ error: response.result.error.message })
        return
      }
      const { content, writable, name, description } = response.result.value
      this.set({
        draft: {
          id: creating ? '' : source,
          source,
          creating,
          content,
          // A copy is always writable: it lands in the local root regardless of
          // where the text came from.
          writable: creating || writable,
          // A copy starts from the source's text but must be renamed, or two
          // rows would present themselves identically.
          name: creating ? '' : name ?? '',
          description: description ?? '',
          saving: false,
          error: null,
        },
      })
    } catch (error) {
      this.set({ error: messageOf(error) })
    }
  }

  /** Close the editor, discarding whatever was typed. */
  close(): void {
    this.set({ draft: null })
  }

  /**
   * Name the preset a new draft saves to.
   * @param id - the id typed into the editor.
   */
  setId(id: string): void {
    this.patchDraft({ id, error: null })
  }

  /**
   * Replace the draft's composition text.
   * @param content - the text in the editor.
   */
  setContent(content: string): void {
    this.patchDraft({ content, error: null })
  }

  /**
   * Rename the draft.
   * @param name - the display name typed into the editor.
   */
  setName(name: string): void {
    this.patchDraft({ name, error: null })
  }

  /**
   * Replace the draft's description.
   * @param description - the description typed into the editor.
   */
  setDescription(description: string): void {
    this.patchDraft({ description, error: null })
  }

  /**
   * Save the open draft, then re-read the roster.
   *
   * The host shape-checks the text, so a composition that could never load is
   * refused here rather than at the next session that selects it.
   * @returns once the write settled and the page reflects it.
   */
  async save(): Promise<void> {
    const draft = this.store.getSnapshot().draft
    if (draft === null || draft.saving || !draft.writable) return
    if (draftBlocker(draft, this.store.getSnapshot().rows) !== undefined) return
    this.patchDraft({ saving: true, error: null })
    try {
      const response = await this.api.agentPresets.write({
        agentPreset: draft.id,
        content: draft.content,
        name: draft.name,
        description: draft.description,
      })
      if (!response.result.ok) {
        this.patchDraft({ saving: false, error: response.result.error.message })
        return
      }
      this.set({ draft: null })
      await this.load()
      this.rosterChanged()
    } catch (error) {
      this.patchDraft({ saving: false, error: messageOf(error) })
    }
  }

  /**
   * Ask for confirmation before deleting one preset.
   * @param id - the preset to delete, or null to dismiss the confirmation.
   */
  confirmDelete(id: string | null): void {
    if (this.store.getSnapshot().deleting) return
    this.set({ pendingDelete: id })
  }

  /**
   * Delete the preset awaiting confirmation, then re-read the roster.
   *
   * A session already composed from it keeps running: its composition was
   * mounted at creation and nothing re-reads the file.
   * @returns once the delete settled and the page reflects it.
   */
  async remove(): Promise<void> {
    const { pendingDelete, deleting, draft } = this.store.getSnapshot()
    if (pendingDelete === null || deleting) return
    this.set({ deleting: true, error: null })
    try {
      const response = await this.api.agentPresets.remove({ agentPreset: pendingDelete })
      if (!response.result.ok) {
        this.set({ deleting: false, pendingDelete: null, error: response.result.error.message })
        return
      }
      this.set({
        deleting: false,
        pendingDelete: null,
        // The editor cannot stay open on a file that no longer exists.
        draft: draft?.id === pendingDelete && !draft.creating ? null : draft,
      })
      await this.load()
      this.rosterChanged()
    } catch (error) {
      this.set({ deleting: false, pendingDelete: null, error: messageOf(error) })
    }
  }

  /**
   * Make one preset the default for sessions created later. Running sessions
   * keep the composition they began with, so this never disturbs work.
   * @param id - the preset to make default.
   * @returns once the write settled and the roster was re-read.
   */
  async makeDefault(id: string): Promise<void> {
    const failure = await writeDefaultPreset(this.api, id)
    if (failure !== undefined) {
      this.set({ error: failure })
      return
    }
    await this.load()
  }
}
