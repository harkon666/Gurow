import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { WebGpuEditor, type WebGpuEditorActions } from '../editor/WebGpuEditor'
import { loadCameraState, saveCameraState } from '../editor/checkpoint'
import type { CameraState } from '../editor/protocol'
import type { GpuStatus, SelectedSkillInfo } from '../editor/types'
import { readCoachVersion, saveVersionLayout, type ApiResult, type CoachPathDocument } from '../../lib/api'
import { Autosave, type SaveState } from './autosave'
import { layoutChanges, layoutWorkProblem, reapplyLayout, sameLayoutWork, type LayoutWork, type WorkContext } from './keptWork'
import { KeptWorkList, SaveConflict } from './KeptWorkPanel'
import { useKeptWork, type SaveAnswer } from './useKeptWork'

/**
 * A published Version's shared Canvas Layout, arranged by its owning Coach (ADR 0005,
 * 0016). Cards can be dragged and the moves undone or redone; Skills, Tasks and
 * Prerequisites stay exactly as published, and the engine refuses any other edit.
 * Completed moves autosave the card positions alone against the Version's layout
 * revision, never creating a Version. A stale save keeps the local arrangement on the
 * canvas, unsaved, and in this browser until the Coach reapplies the moves onto the
 * accepted layout as a new save or discards them; moves never accepted are offered
 * again on reopening. Undoing a saved move is sent as a new save. Camera state is
 * stored only locally, per Account and Version.
 */

const AUTOSAVE_DELAY_MS = 500

type LayoutCards = LayoutWork

/** The camera's local storage context: the Coach's own view of this Version's layout. */
export const versionCameraContext = (versionId: string) => `version:${versionId}`

const cardsOf = (document: CoachPathDocument) => document.editor.cards.map((card) => ({ id: card.id, title: card.title, position: card.position }))
const layoutOf = (document: CoachPathDocument): LayoutWork => document.editor.cards.map((card) => ({ id: card.id, position: card.position }))

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

  const build = useCallback((): LayoutCards | null => {
    const snapshot = actionsRef.current?.exportSnapshot()
    return snapshot ? snapshot.cards.map((card) => ({ id: card.id, position: card.position })) : null
  }, [])

  /** One layout save against `expectedRevision`; only the backend says whether it is still the accepted layout. */
  const saveLayout = useCallback(async (cards: LayoutCards, expectedRevision: number): Promise<SaveAnswer<CoachPathDocument>> => {
    let result: ApiResult<CoachPathDocument>
    try {
      result = await saveVersionLayout(version.id, { expectedRevision, cards })
    } catch {
      return { kind: 'failed', detail: 'the backend could not be reached' }
    }
    if (result.ok) return { kind: 'accepted', accepted: result.value }
    const detail = typeof result.body?.detail === 'string' ? result.body.detail : result.error
    if (result.error === 'stale_revision') {
      const current = result.body?.current as CoachPathDocument | undefined
      return { kind: 'stale', revision: current?.version?.layoutRevision ?? expectedRevision }
    }
    if (result.status === 401 || result.status === 404) return { kind: 'refused', detail: 'this Version is not available to the signed-in Account' }
    if (result.status === 422 || result.status === 409) return { kind: 'refused', detail }
    return { kind: 'failed', detail }
  }, [version.id])

  const titles = useMemo(() => new Map(document.editor.cards.map((card) => [card.id, card.title])), [document])
  const context = useMemo<WorkContext>(() => ({ accountId, kind: 'layout', pathId: document.learningPath.id, versionId: version.id }), [accountId, document.learningPath.id, version.id])
  // Moves the backend has not accepted stay in this browser, so a reload or a crash does not lose them.
  const { session: kept, view: keptView } = useKeptWork<LayoutWork, CoachPathDocument>({
    context,
    initial: { revision: version.layoutRevision, work: layoutOf(document) },
    problem: layoutWorkProblem,
    same: sameLayoutWork,
    merge: reapplyLayout,
    changes: (base, mine) => layoutChanges(base, mine, titles),
    build,
    read: async () => {
      const result = await readCoachVersion(version.id)
      return result.ok && result.value.version
        ? { ok: true, revision: result.value.version.layoutRevision, work: layoutOf(result.value), accepted: result.value }
        : { ok: false, detail: result.ok ? 'no Version' : result.error }
    },
    save: saveLayout,
    revisionOf: (accepted) => accepted.version!.layoutRevision,
    show: (accepted) => showAccepted(accepted),
  })

  useEffect(() => {
    // Always sent: only the backend can say whether this tab is still on the accepted layout.
    const send = (cards: LayoutCards, expectedRevision: number) => kept.autosave(cards, expectedRevision)
    const onState = (state: SaveState) => {
      setSaveState(state)
      kept.saveStateChanged(state)
    }
    const autosave = new Autosave<LayoutCards>({ revision: version.layoutRevision, delayMs: AUTOSAVE_DELAY_MS, build, send, onState })
    autosaveRef.current = autosave
    return () => autosave.close()
  }, [version.layoutRevision, build, kept])

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
  const edited = useCallback(() => {
    autosaveRef.current?.edit()
    // After a conflict the move is not sent, but it is kept with the rest of the local arrangement.
    kept.remember()
  }, [kept])

  /** Shows an accepted layout, replacing the arrangement on the canvas, and autosaves from its revision. */
  const showAccepted = (accepted: CoachPathDocument) => {
    setLoadError(null)
    actionsRef.current?.selectCard(null)
    setSelected(null)
    setLoaded(cardsOf(accepted))
    kept.shown(accepted.version!.layoutRevision, layoutOf(accepted))
    autosaveRef.current?.reset(accepted.version!.layoutRevision)
  }

  /**
   * After a conflict: shows the accepted layout, with the local arrangement kept aside
   * (offered for reapplying) or discarded. If the layout cannot be read, nothing
   * changes: autosave stays stopped by the conflict and its choices stay.
   */
  const loadAccepted = async (keepMine: boolean) => {
    const outcome = await kept.loadAccepted(keepMine)
    if (outcome.kind === 'failed') setLoadError(`could not load the saved layout (${outcome.detail}); your arrangement is still here, unsaved`)
  }
  // While kept moves are reapplied or the saved layout loads, the canvas is not edited: the accepted result replaces what it shows.
  const reapplying = keptView.busy

  return (
    <section id="version-layout" data-version-id={version.id} data-gpu-status={gpuStatus} aria-labelledby="version-layout-heading" className="flex flex-col border border-slate-800 rounded-xl overflow-hidden">
      <div className="shrink-0 px-3 py-2 bg-slate-900/60 border-b border-slate-800/80 flex flex-wrap items-center gap-3">
        <h2 id="version-layout-heading" className="text-sm font-semibold text-slate-100">Shared Canvas Layout</h2>
        <LayoutSaveStatus state={saveState} onRetry={() => autosaveRef.current?.retry()} />
        {selected && <span id="version-layout-selected" className="text-xs text-slate-400">Selected: {selected.title}</span>}
      </div>
      <p id="version-layout-note" className="shrink-0 px-3 py-1.5 text-[11px] text-slate-400 border-b border-slate-800/80">
        Drag cards to make this Version easier to read. Its learners see the new arrangement when they next open it, each with their own view. Only positions change: Skills, Tasks, Prerequisites and learning records stay as they are, and no new Version is published.
      </p>
      {saveState.kind === 'conflict' && (
        <SaveConflict
          prefix="layout-"
          noun="layout"
          revisionLabel="Layout revision"
          acceptedRevision={saveState.acceptedRevision}
          changes={keptView.liveChanges}
          status={keptView.live}
          busy={keptView.busy}
          loadError={loadError}
          onReapply={() => void kept.reapplyLive()}
          onKeepAside={() => void loadAccepted(true)}
          onDiscard={() => void loadAccepted(false)}
        />
      )}
      <KeptWorkList
        prefix="layout-"
        noun="layout"
        entries={keptView.entries}
        refused={keptView.refused}
        busy={keptView.busy}
        currentRevision={saveState.revision}
        canReapply={saveState.kind === 'saved' && gpuStatus !== 'initializing'}
        onReapply={(id) => void kept.reapply(id)}
        onDiscard={(id) => kept.discard(id)}
        onDismissRefused={() => kept.dismissRefused()}
      />
      <div inert={reapplying} aria-busy={reapplying} className={`h-[28rem] flex ${reapplying ? 'pointer-events-none opacity-60' : ''}`}>
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
function LayoutSaveStatus({ state, onRetry }: { state: SaveState; onRetry: () => void }) {
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
    </div>
  )
}
