import { createFileRoute } from '@tanstack/react-router'
import { useState, useEffect, useRef, useCallback } from 'react'
import { WebGpuEditor, type WebGpuEditorActions } from '../components/editor/WebGpuEditor'
import { SkillDetailPanel } from '../components/editor/SkillDetailPanel'
import { SkillPrerequisiteList } from '../components/editor/SkillPrerequisiteList'
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

// The P1 local-fixture editor (ADR 0016). It reads no Account or Workspace data;
// T16 brings the editor into a signed-in Personal Workspace Path.
export const Route = createFileRoute('/editor')({ component: LearningPathEditorPage })

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

  const handleSelectListSkill = useCallback((skill: SelectedSkillInfo | null) => {
    setSelectedSkill(skill)
    if (skill) {
      actionsRef.current?.selectCard(skill.id)
    } else {
      actionsRef.current?.selectCard(null)
    }
  }, [])

  // Resolve active skill's learning payload from application state
  const currentSkillPayload = applicationSkills.find((s) => s.id === selectedSkill?.id)

  return (
    <main
      className="w-full h-full flex flex-col overflow-hidden bg-slate-950 select-none"
      data-checkpoint-saved-at={lastSavedAt ?? ''}
      data-checkpoint-revision={revision}
    >
      {/* Top Figma-Style Header Bar */}
      <header className="h-11 shrink-0 bg-slate-900/90 border-b border-slate-800/80 px-4 flex items-center justify-between z-30 select-none">
        <div className="flex items-center gap-2.5">
          <div className="w-5 h-5 rounded bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400 font-bold text-[10px] tracking-wider">
            G
          </div>
          <span className="font-semibold text-xs text-slate-200 tracking-tight">
            Gurow
          </span>
          <span className="text-slate-600 text-xs">/</span>
          <span className="text-xs text-slate-400 font-medium">
            Editor
          </span>
        </div>

        <div className="flex items-center gap-2.5">
          <span
            id="checkpoint-status-badge"
            data-state={checkpointError || isCheckpointRejectedRef.current ? 'rejected' : lastSavedAt ? 'saved' : 'fixture'}
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
              {checkpointError || isCheckpointRejectedRef.current
                ? 'Not saved · local work preserved'
                : lastSavedAt
                ? 'Saved locally'
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
      </header>

      {/* Checkpoint Mismatch Alert Banner */}
      {checkpointError && (
        <div
          id="checkpoint-error-alert"
          className="bg-red-950/90 border-b border-red-800/80 px-4 py-2 text-xs text-red-200 flex items-center justify-between shadow-lg shrink-0 z-40"
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
        className="w-full flex-1 min-h-0 flex flex-col md:flex-row overflow-y-auto md:overflow-hidden bg-slate-950 relative"
      >
        {mounted ? (
          <>
            <WebGpuEditor
              navigation={<SkillPrerequisiteList
                skills={applicationSkills}
                connections={connections}
                selectedSkillId={selectedSkill?.id ?? null}
                onSelectSkill={handleSelectListSkill}
              />}
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
              onClose={() => handleSelectListSkill(null)}
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
