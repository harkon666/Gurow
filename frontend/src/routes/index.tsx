import { createFileRoute } from '@tanstack/react-router'
import { useState, useEffect, useRef, useCallback } from 'react'
import { WebGpuEditor, type WebGpuEditorActions } from '../components/editor/WebGpuEditor'
import { SkillDetailPanel } from '../components/editor/SkillDetailPanel'
import type { SelectedSkillInfo } from '../components/editor/types'
import type {
  PrerequisiteConnection,
  SkillCard,
  CameraState,
  LearningPathCheckpoint,
} from '../components/editor/protocol'
import {
  loadCheckpoint,
  saveCheckpoint,
  loadCameraState,
  saveCameraState,
  clearLocalScene,
  CheckpointMismatchError,
} from '../components/editor/checkpoint'
import {
  INITIAL_LEARNING_PATH_FIXTURE,
  type FixtureSkill,
  type FixtureTask,
} from '../fixtures/learningPath'

const ACCOUNT_ID = 'fixture-user'
const PATH_ID = INITIAL_LEARNING_PATH_FIXTURE.id

export const Route = createFileRoute('/')({ component: LearningPathEditorPage })

function LearningPathEditorPage() {
  const [mounted, setMounted] = useState(false)
  const [selectedSkill, setSelectedSkill] = useState<SelectedSkillInfo | null>(null)
  const [connections, setConnections] = useState<PrerequisiteConnection[]>([])
  const [connectionRejection, setConnectionRejection] = useState<string | null>(null)
  const [applicationSkills, setApplicationSkills] = useState<FixtureSkill[]>(
    INITIAL_LEARNING_PATH_FIXTURE.skills
  )
  const [initialCards, setInitialCards] = useState<SkillCard[]>([])
  const [initialConnections, setInitialConnections] = useState<PrerequisiteConnection[]>([])
  const [initialCamera, setInitialCamera] = useState<CameraState | null>(null)
  const [checkpointError, setCheckpointError] = useState<string | null>(null)
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null)
  const [revision, setRevision] = useState<number>(1)

  const actionsRef = useRef<WebGpuEditorActions | null>(null)
  const revisionRef = useRef<number>(1)
  revisionRef.current = revision

  const applicationSkillsRef = useRef<FixtureSkill[]>(applicationSkills)
  applicationSkillsRef.current = applicationSkills

  const isCheckpointRejectedRef = useRef<boolean>(false)
  const checkpointErrorRef = useRef<string | null>(null)
  checkpointErrorRef.current = checkpointError

  // Load checkpoint & camera state on mount (ADR-0016)
  useEffect(() => {
    try {
      if (typeof window !== 'undefined') {
        const savedCheckpoint = loadCheckpoint(window.localStorage, ACCOUNT_ID, PATH_ID)
        const savedCamera = loadCameraState(window.localStorage, ACCOUNT_ID, PATH_ID)

        if (savedCheckpoint) {
          // Checkpoint validated successfully with semantic integrity check
          setInitialCards(savedCheckpoint.editor.cards)
          setInitialConnections(savedCheckpoint.editor.connections)
          setInitialCamera(savedCamera)
          setRevision(savedCheckpoint.editor.revision)
          setLastSavedAt(savedCheckpoint.saved_at)

          const restoredSkills: FixtureSkill[] = savedCheckpoint.application.skills.map(
            (s) => {
              const editorCard = savedCheckpoint.editor.cards.find((c) => c.id === s.id)
              return {
                id: s.id,
                title: editorCard?.title ?? s.id,
                outcome: s.outcome,
                initialPosition: editorCard?.position ?? { x: 0, y: 0 },
                tasks: s.tasks,
              }
            }
          )
          setApplicationSkills(restoredSkills)
        } else {
          // Fallback to default fixture
          setInitialCards(
            INITIAL_LEARNING_PATH_FIXTURE.skills.map((s) => ({
              id: s.id,
              title: s.title,
              position: { x: s.initialPosition.x, y: s.initialPosition.y },
              size: { width: 180, height: 80 },
            }))
          )
          setInitialConnections([])
          setInitialCamera(savedCamera)
          setApplicationSkills(INITIAL_LEARNING_PATH_FIXTURE.skills)
        }
      }
    } catch (err: unknown) {
      console.error('Local checkpoint validation failed:', err)
      isCheckpointRejectedRef.current = true
      const msg =
        err instanceof CheckpointMismatchError
          ? `Integrity mismatch: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err)
      setCheckpointError(msg)
      // Mismatched associations must NOT be silently restored (AC 3)
      setInitialCards(
        INITIAL_LEARNING_PATH_FIXTURE.skills.map((s) => ({
          id: s.id,
          title: s.title,
          position: { x: s.initialPosition.x, y: s.initialPosition.y },
          size: { width: 180, height: 80 },
        }))
      )
      setInitialConnections([])
      setApplicationSkills(INITIAL_LEARNING_PATH_FIXTURE.skills)
    } finally {
      setMounted(true)
    }
  }, [])

  const handleActionsReady = useCallback((actions: WebGpuEditorActions) => {
    actionsRef.current = actions
  }, [])

  const saveActiveCheckpoint = useCallback(
    (currentSkills?: FixtureSkill[]) => {
      // Guard: never overwrite or save if a checkpoint error or rejected state exists (ADR-0016)
      if (checkpointErrorRef.current || isCheckpointRejectedRef.current) {
        console.warn(
          'Preserving rejected checkpoint: skipping save because of checkpoint error:',
          checkpointErrorRef.current
        )
        return
      }

      const actions = actionsRef.current
      if (!actions || typeof window === 'undefined') return

      const snapshot = actions.exportSnapshot()
      if (!snapshot) return

      const skillsToSave = currentSkills ?? applicationSkillsRef.current
      const nextRevision = revisionRef.current + 1

      const checkpoint: LearningPathCheckpoint = {
        version: 1,
        saved_at: new Date().toISOString(),
        editor: {
          format_version: 1,
          revision: nextRevision,
          cards: snapshot.cards,
          connections: snapshot.connections,
        },
        application: {
          learning_path_id: PATH_ID,
          skills: skillsToSave.map((s) => ({
            id: s.id,
            outcome: s.outcome,
            tasks: s.tasks,
          })),
        },
      }

      try {
        saveCheckpoint(window.localStorage, ACCOUNT_ID, PATH_ID, checkpoint)
        setRevision(nextRevision)
        setLastSavedAt(checkpoint.saved_at)
        setCheckpointError(null)
      } catch (err: unknown) {
        console.error('Failed to save checkpoint:', err)
        isCheckpointRejectedRef.current = true
        const msg = err instanceof Error ? err.message : String(err)
        setCheckpointError(msg)
      }
    },
    []
  )

  const handleOperationCompleted = useCallback(() => {
    saveActiveCheckpoint()
  }, [saveActiveCheckpoint])

  const handleCameraChanged = useCallback((camera: CameraState) => {
    if (typeof window !== 'undefined') {
      saveCameraState(window.localStorage, ACCOUNT_ID, PATH_ID, camera)
    }
  }, [])

  const handleConnect = useCallback((fromId: string, toId: string) => {
    actionsRef.current?.connectSkills(fromId, toId)
  }, [])

  const handleDisconnect = useCallback((fromId: string, toId: string) => {
    actionsRef.current?.disconnectSkills(fromId, toId)
  }, [])

  const handleCreateSkill = useCallback(() => {
    if (checkpointErrorRef.current || isCheckpointRejectedRef.current) return
    // The actions adapter is published before asynchronous engine initialization.
    // Do not add application data until a live document is available.
    if (!actionsRef.current?.exportSnapshot()) return

    const newIndex = applicationSkillsRef.current.length + 1
    const newId = `skill-custom-${Date.now()}`
    const newTitle = `Skill ${newIndex}`
    const newPos = {
      x: 320,
      y: 120 + ((newIndex - 3) % 4) * 110,
    }

    const newSkill: FixtureSkill = {
      id: newId,
      title: newTitle,
      outcome: `Master ${newTitle} and demonstrate core concepts`,
      initialPosition: newPos,
      tasks: [
        {
          id: `task-${newId}-intro`,
          title: `Setup ${newTitle}`,
          description: `Initial task for ${newTitle}`,
          required: true,
        },
      ],
    }

    const nextSkills = [...applicationSkillsRef.current, newSkill]
    applicationSkillsRef.current = nextSkills
    setApplicationSkills(nextSkills)

    actionsRef.current?.createCard(newId, newTitle, newPos)
  }, [])

  const handleUpdateTask = useCallback(
    (taskId: string, updates: Partial<FixtureTask>) => {
      if (!selectedSkill) return
      setApplicationSkills((prevSkills) => {
        const nextSkills = prevSkills.map((skill) => {
          if (skill.id !== selectedSkill.id) return skill
          return {
            ...skill,
            tasks: skill.tasks.map((task) => {
              if (task.id !== taskId) return task
              return { ...task, ...updates }
            }),
          }
        })
        setTimeout(() => saveActiveCheckpoint(nextSkills), 0)
        return nextSkills
      })
    },
    [selectedSkill, saveActiveCheckpoint]
  )

  const handleResetScene = useCallback(() => {
    if (typeof window !== 'undefined') {
      isCheckpointRejectedRef.current = false
      clearLocalScene(window.localStorage, ACCOUNT_ID, PATH_ID)
      window.location.reload()
    }
  }, [])

  // Resolve active skill's learning payload from application state
  const currentSkillPayload = applicationSkills.find((s) => s.id === selectedSkill?.id)

  return (
    <main
      className="px-4 py-6 max-w-7xl mx-auto flex flex-col gap-5"
      data-checkpoint-saved-at={lastSavedAt ?? ''}
      data-checkpoint-revision={revision}
    >
      {/* Learning Path Header Info */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-slate-900/50 p-5 rounded-2xl border border-slate-800/80 backdrop-blur-sm">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              P1 Slice: WebGPU Editor
            </span>
            <span className="text-xs text-slate-500 font-mono">
              US08 • US73 • US76 • US78 • US83
            </span>
          </div>
          <h1 className="text-2xl font-bold text-slate-100 tracking-tight">
            {INITIAL_LEARNING_PATH_FIXTURE.title}
          </h1>
          <p className="text-xs text-slate-400 mt-1 max-w-2xl">
            {INITIAL_LEARNING_PATH_FIXTURE.description}
          </p>
        </div>

        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-2">
            <span
              id="checkpoint-status-badge"
              className="text-[11px] font-mono text-slate-400 bg-slate-950/80 px-2.5 py-1 rounded-lg border border-slate-800 flex items-center gap-1.5"
            >
              <span
                className={`w-2 h-2 rounded-full ${
                  checkpointError
                    ? 'bg-red-400'
                    : lastSavedAt
                    ? 'bg-emerald-400'
                    : 'bg-slate-400'
                }`}
              />
              <span>
                {checkpointError
                  ? 'Checkpoint Error (Preserved)'
                  : lastSavedAt
                  ? `Saved locally (rev #${revision})`
                  : 'Default Fixture'}
              </span>
            </span>

            <button
              id="btn-reset-scene"
              onClick={handleResetScene}
              className="text-xs text-slate-400 hover:text-slate-200 bg-slate-800/80 hover:bg-slate-700/80 border border-slate-700/60 px-2.5 py-1 rounded-lg cursor-pointer transition-colors"
              title="Clear local checkpoint and restore initial fixture"
            >
              Reset Scene
            </button>
          </div>

          <div className="text-[11px] text-slate-500 font-mono">
            Boundary: Rust Engine (Wasm) + React Domain Store
          </div>
        </div>
      </div>

      {/* Checkpoint Mismatch Alert Banner */}
      {checkpointError && (
        <div
          id="checkpoint-error-alert"
          className="bg-red-950/80 border border-red-800 rounded-xl p-3.5 text-xs text-red-200 flex items-center justify-between shadow-lg"
        >
          <div className="flex items-center gap-2">
            <span className="font-semibold text-red-400">⚠️ Checkpoint Error:</span>
            <span>{checkpointError}</span>
          </div>
          <button
            onClick={() => setCheckpointError(null)}
            className="text-red-400 hover:text-red-200 font-bold ml-4 cursor-pointer"
          >
            ✕
          </button>
        </div>
      )}

      {/* Editor Main Canvas & Panel Container */}
      <section
        id="canvas-editor-container"
        className="h-[640px] w-full rounded-2xl border border-slate-800 shadow-2xl overflow-hidden bg-slate-950 flex flex-col md:flex-row"
      >
        {mounted ? (
          <>
            <WebGpuEditor
              onSelectSkill={setSelectedSkill}
              onConnectionsChange={setConnections}
              onRejection={setConnectionRejection}
              onActionsReady={handleActionsReady}
              onCreateSkill={handleCreateSkill}
              initialCards={initialCards}
              initialConnections={initialConnections}
              initialCamera={initialCamera}
              onOperationCompleted={handleOperationCompleted}
              onCameraChanged={handleCameraChanged}
            />
            <SkillDetailPanel
              selectedSkill={selectedSkill}
              allSkills={applicationSkills}
              connections={connections}
              connectionRejection={connectionRejection}
              onClearRejection={() => setConnectionRejection(null)}
              onConnect={handleConnect}
              onDisconnect={handleDisconnect}
              tasks={currentSkillPayload?.tasks}
              outcome={currentSkillPayload?.outcome}
              onUpdateTask={handleUpdateTask}
            />
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-slate-500 text-sm">
            Initializing Editor Environment...
          </div>
        )}
      </section>
    </main>
  )
}
