import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { WebGpuEditor, type WebGpuEditorActions } from '../editor/WebGpuEditor'
import { loadCameraState, saveCameraState } from '../editor/checkpoint'
import type { CameraState } from '../editor/protocol'
import type { GpuStatus, SelectedSkillInfo } from '../editor/types'
import { readCoachVersion, saveVersionLayout, type CoachPathDocument, type LayoutSave } from '../../lib/api'
import { Autosave, type SaveOutcome, type SaveState } from './autosave'

/**
 * A published Version's shared Canvas Layout, arranged by its owning Coach (ADR 0005,
 * 0016). Cards can be dragged and the moves undone or redone; Skills, Tasks and
 * Prerequisites stay exactly as published, and the engine refuses any other edit.
 * Completed moves autosave the card positions alone against the Version's layout
 * revision, never creating a Version. A stale save keeps the local arrangement on the
 * canvas, unsaved, until the Coach discards it. Undoing a saved move is sent as a new
 * save. Camera state is stored only locally, per Account and Version.
 */

const AUTOSAVE_DELAY_MS = 500

type LayoutCards = LayoutSave['cards']

/** The camera's local storage context: the Coach's own view of this Version's layout. */
export const versionCameraContext = (versionId: string) => `version:${versionId}`

const cardsOf = (document: CoachPathDocument) => document.editor.cards.map((card) => ({ id: card.id, title: card.title, position: card.position }))

export function VersionLayoutEditor({ accountId, document }: { accountId: string; document: CoachPathDocument }) {
  const version = document.version!
  const [loaded, setLoaded] = useState(() => cardsOf(document))
  const [connections] = useState(() => document.editor.connections)
  const [camera] = useState<CameraState | null>(() => (typeof window === 'undefined' ? null : loadCameraState(window.localStorage, accountId, versionCameraContext(version.id))))
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'saved', revision: version.layoutRevision })
  /** Why loading the saved layout to discard local moves failed; the conflict, and its Discard, stay meanwhile. */
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selected, setSelected] = useState<SelectedSkillInfo | null>(null)
  const [gpuStatus, setGpuStatus] = useState<GpuStatus>('initializing')
  const actionsRef = useRef<WebGpuEditorActions | null>(null)
  const autosaveRef = useRef<Autosave<LayoutCards> | null>(null)

  useEffect(() => {
    const build = (): LayoutCards | null => {
      const snapshot = actionsRef.current?.exportSnapshot()
      return snapshot ? snapshot.cards.map((card) => ({ id: card.id, position: card.position })) : null
    }
    const send = async (cards: LayoutCards, expectedRevision: number): Promise<SaveOutcome> => {
      // Always sent: only the backend can say whether this tab is still on the accepted layout.
      const result = await saveVersionLayout(version.id, { expectedRevision, cards })
      if (result.ok) return { kind: 'accepted', revision: result.value.version!.layoutRevision }
      const detail = typeof result.body?.detail === 'string' ? result.body.detail : result.error
      if (result.error === 'stale_revision') {
        const current = result.body?.current as CoachPathDocument | undefined
        return { kind: 'stale', acceptedRevision: current?.version?.layoutRevision ?? expectedRevision }
      }
      if (result.status === 401 || result.status === 404) return { kind: 'rejected', detail: 'this Version is not available to the signed-in Account' }
      if (result.status === 422 || result.status === 409) return { kind: 'rejected', detail }
      return { kind: 'failed', detail }
    }
    const autosave = new Autosave<LayoutCards>({ revision: version.layoutRevision, delayMs: AUTOSAVE_DELAY_MS, build, send, onState: setSaveState })
    autosaveRef.current = autosave
    return () => autosave.close()
  }, [version.id, version.layoutRevision])

  // A layout cleanup runs before the engine is freed, so a move still waiting for its delay can be built and sent.
  useLayoutEffect(() => () => autosaveRef.current?.close(), [])

  // Closing or reloading the page with moves the backend has not accepted asks first.
  const unsaved = saveState.kind !== 'saved'
  useEffect(() => {
    if (!unsaved) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [unsaved])

  const handleActionsReady = useCallback((actions: WebGpuEditorActions) => { actionsRef.current = actions }, [])
  const handleCameraChanged = useCallback((next: CameraState) => {
    if (typeof window !== 'undefined') saveCameraState(window.localStorage, accountId, versionCameraContext(version.id), next)
  }, [accountId, version.id])
  const edited = useCallback(() => autosaveRef.current?.edit(), [])

  /**
   * Drops the unsaved local arrangement and shows the accepted layout. If the layout
   * cannot be read, nothing changes: autosave stays stopped by the conflict, so the
   * Coach can only try again from the same control.
   */
  const loadAccepted = async () => {
    const result = await readCoachVersion(version.id).catch(() => null)
    if (!result?.ok || !result.value.version) {
      const reason = !result ? 'the backend could not be reached' : result.ok ? 'no Version' : result.error
      setLoadError(`could not load the saved layout (${reason}); your arrangement is still here, unsaved`)
      return
    }
    setLoadError(null)
    actionsRef.current?.selectCard(null)
    setSelected(null)
    setLoaded(cardsOf(result.value))
    autosaveRef.current?.reset(result.value.version.layoutRevision)
  }

  return (
    <section id="version-layout" data-version-id={version.id} data-gpu-status={gpuStatus} aria-labelledby="version-layout-heading" className="flex flex-col border border-slate-800 rounded-xl overflow-hidden">
      <div className="shrink-0 px-3 py-2 bg-slate-900/60 border-b border-slate-800/80 flex flex-wrap items-center gap-3">
        <h2 id="version-layout-heading" className="text-sm font-semibold text-slate-100">Shared Canvas Layout</h2>
        <LayoutSaveStatus state={saveState} loadError={loadError} onRetry={() => autosaveRef.current?.retry()} onLoadAccepted={() => void loadAccepted()} />
        {selected && <span id="version-layout-selected" className="text-xs text-slate-400">Selected: {selected.title}</span>}
      </div>
      <p id="version-layout-note" className="shrink-0 px-3 py-1.5 text-[11px] text-slate-400 border-b border-slate-800/80">
        Drag cards to make this Version easier to read. Its learners see the new arrangement when they next open it, each with their own view. Only positions change: Skills, Tasks, Prerequisites and learning records stay as they are, and no new Version is published.
      </p>
      <div className="h-[28rem] flex">
        <WebGpuEditor
          layoutOnly
          onSelectSkill={setSelected}
          onActionsReady={handleActionsReady}
          initialCards={loaded}
          initialConnections={connections}
          initialCamera={camera}
          onOperationCompleted={edited}
          onCameraChanged={handleCameraChanged}
          onGpuStatusChange={setGpuStatus}
        />
      </div>
    </section>
  )
}

/** Tells the Coach whether the arrangement on the canvas is saved; only a backend acceptance says so. */
function LayoutSaveStatus({ state, loadError, onRetry, onLoadAccepted }: { state: SaveState; loadError: string | null; onRetry: () => void; onLoadAccepted: () => void }) {
  const text = {
    saved: `Saved · layout revision ${state.revision}`,
    dirty: 'Unsaved changes',
    saving: 'Saving…',
    conflict: 'Not saved: this layout was changed elsewhere',
    rejected: 'Not saved: the change was refused',
    failed: 'Not saved: the save failed',
  }[state.kind]
  const tone = state.kind === 'saved' ? 'text-emerald-300 border-emerald-800/60' : state.kind === 'dirty' || state.kind === 'saving' ? 'text-slate-300 border-slate-700' : 'text-red-300 border-red-800/70'
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span id="layout-save-status" role="status" data-state={state.kind} data-revision={state.revision} className={`px-2 py-1 rounded-lg border bg-slate-950/80 ${tone}`}>
        {text}
      </span>
      {(state.kind === 'rejected' || state.kind === 'failed') && (
        <>
          <span id="layout-save-error" role="alert" className="text-red-300 max-w-[20rem] truncate" title={state.detail}>{state.detail}</span>
          <button id="layout-retry-save-btn" onClick={onRetry} className="text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2 py-1 rounded-lg cursor-pointer">Retry</button>
        </>
      )}
      {state.kind === 'conflict' && (
        <div id="layout-save-conflict" role="alert" className="flex flex-wrap items-center gap-2 text-amber-200">
          <span>Layout revision {state.acceptedRevision} was saved elsewhere. Your arrangement here is kept but not saved.</span>
          <button id="layout-load-accepted-btn" onClick={onLoadAccepted} className="text-amber-100 bg-amber-900/60 hover:bg-amber-800/60 border border-amber-700 px-2 py-1 rounded-lg cursor-pointer">
            {loadError ? 'Try loading the saved layout again' : 'Discard mine and load the saved layout'}
          </button>
          {loadError && <span id="layout-load-error" className="text-red-300">{loadError}</span>}
        </div>
      )}
    </div>
  )
}
