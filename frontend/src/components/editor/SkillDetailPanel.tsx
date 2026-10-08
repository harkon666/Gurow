import React, { useState } from 'react'
import { TemporaryPanel } from './TemporaryPanel'
import { connectionRejectionKind, connectionRejectionMessage, isConnectionRejection } from './connectionRejection'
import { INITIAL_LEARNING_PATH_FIXTURE } from '../../fixtures/learningPath'
import type { SelectedSkillInfo } from './types'
import type { PrerequisiteConnection } from './protocol'

/**
 * A Task as the sidebar edits it. `required` exists only where the mode has
 * Required and Enrichment Tasks; personal Tasks have none.
 */
export interface PanelTask {
  id: string
  title: string
  description: string
  required?: boolean
}

interface SkillDetailPanelProps {
  selectedSkill: SelectedSkillInfo | null
  onClose: () => void
  feedback?: React.ReactNode
  busy?: boolean
  connections?: PrerequisiteConnection[]
  allSkills?: Array<{ id: string; title: string }>
  onConnect?: (fromId: string, toId: string) => void
  onDisconnect?: (fromId: string, toId: string) => void
  connectionRejection?: string | null
  onClearRejection?: () => void
  tasks?: PanelTask[]
  outcome?: string
  /** Makes Tasks editable; without it they are shown read-only. */
  onUpdateTask?: (taskId: string, updates: Partial<PanelTask>) => void
  /** Makes the learning outcome editable. */
  onUpdateOutcome?: (outcome: string) => void
  /** Offers adding a Task to the selected Skill. */
  onAddTask?: () => void
  /** Learning records of the selected Skill (Access, Mastery, XP), shown after its outcome. */
  learning?: React.ReactNode
  settings?: React.ReactNode
  history?: React.ReactNode
  editLabel?: string
  tasksLabel?: string
  /** Queue navigation requests Tasks without exposing a learner's private board. */
  tasksRequest?: string | null
  /** Infrequent Skill actions (such as deletion), behind the summary actions menu. */
  skillActions?: React.ReactNode
  /** Primary summary-footer action for contexts with a Task Board. */
  boardAction?: React.ReactNode
  /** Learning controls shown inside each Task card. */
  renderTaskExtra?: (taskId: string) => React.ReactNode
}

interface ConnectionListItemProps {
  fromId: string
  toId: string
  title: string
  direction: '←' | '→'
  onDisconnect?: (fromId: string, toId: string) => void
}

const ConnectionListItem: React.FC<ConnectionListItemProps> = ({
  fromId,
  toId,
  title,
  direction,
  onDisconnect,
}) => (
  <li className="flex items-center justify-between text-xs bg-slate-900/60 px-2.5 py-1.5 rounded border border-slate-800">
    <span className="text-slate-200 truncate max-w-[170px]" title={title}>
      {direction} {title}
    </span>
    {onDisconnect && (
      <button
        id={`disconnect-${fromId}-${toId}`}
        onClick={() => onDisconnect(fromId, toId)}
        aria-label={`Remove connection ${direction === '←' ? 'from' : 'to'} ${title}`}
        className="text-[10px] text-red-400 hover:text-red-300 ml-2 px-1 py-0.5 rounded bg-red-950/40 hover:bg-red-950/80 transition-colors cursor-pointer"
        title="Remove connection"
      >
        ✕
      </button>
    )}
  </li>
)

export const SkillDetailPanel: React.FC<SkillDetailPanelProps> = ({
  selectedSkill,
  onClose,
  feedback,
  busy = false,
  connections = [],
  allSkills = INITIAL_LEARNING_PATH_FIXTURE.skills.map((s) => ({ id: s.id, title: s.title })),
  onConnect,
  onDisconnect,
  connectionRejection,
  onClearRejection,
  tasks,
  outcome,
  onUpdateTask,
  onUpdateOutcome,
  onAddTask,
  learning,
  settings,
  history,
  editLabel = 'Edit Skill',
  tasksLabel = 'Tasks',
  tasksRequest,
  skillActions,
  boardAction,
  renderTaskExtra,
}) => {
  const [selectedTargetId, setSelectedTargetId] = useState<string>('')
  const [view, setView] = useState<'summary' | 'edit' | 'prerequisites' | 'history' | 'tasks'>('summary')
  const [actionsOpen, setActionsOpen] = useState(false)
  const bodyRef = React.useRef<HTMLElement>(null)
  const returnFocus = React.useRef<string | null>(null)
  const changeView = (next: typeof view, trigger?: string) => {
    returnFocus.current = next === 'summary' ? returnFocus.current : trigger ?? null
    setActionsOpen(false)
    setView(next)
  }
  React.useEffect(() => {
    const body = bodyRef.current
    if (!body) return
    body.parentElement?.scrollTo(0, 0)
    if (view !== 'summary') document.getElementById('btn-back-skill-summary')?.focus()
    else if (returnFocus.current) document.getElementById(returnFocus.current)?.focus()
  }, [view])
  React.useEffect(() => {
    if (tasksRequest) setView('tasks')
  }, [tasksRequest])

  // Reset selectedTargetId whenever the active skill selection changes
  React.useEffect(() => {
    setSelectedTargetId('')
    setView(tasksRequest ? 'tasks' : 'summary')
    setActionsOpen(false)
    returnFocus.current = null
  }, [selectedSkill?.id])

  if (!selectedSkill) return <div id="skill-detail-panel" hidden data-connections={JSON.stringify(connections)} data-connections-count={connections.length} />

  // Lookup learning metadata from props or application fixture; title is authoritative from engine
  const fixtureSkill = INITIAL_LEARNING_PATH_FIXTURE.skills.find(
    (s) => s.id === selectedSkill.id
  )

  const activeOutcome = outcome ?? fixtureSkill?.outcome ?? ''
  const activeTasks: PanelTask[] = tasks ?? fixtureSkill?.tasks ?? []

  // Derived prerequisite connections for this skill
  const incomingPrereqs = connections.filter((c) => c.to_id === selectedSkill.id)
  const outgoingDependents = connections.filter((c) => c.from_id === selectedSkill.id)

  const tasksEditable = onUpdateTask !== undefined
  const otherSkills = allSkills.filter((s) => s.id !== selectedSkill.id)
  // Ensure validTargetId strictly belongs to otherSkills, preventing self-connection or stale targets
  const validTargetId =
    otherSkills.find((s) => s.id === selectedTargetId)?.id ?? (otherSkills[0]?.id ?? '')

  return (
    <TemporaryPanel title={view === 'summary' ? 'Skill summary' : view === 'edit' ? editLabel : view === 'prerequisites' ? 'Manage prerequisites' : view === 'history' ? 'Skill history' : tasksLabel} closeId="btn-close-skill-details" onClose={onClose}
      onEscape={view !== 'summary' || actionsOpen ? () => { if (actionsOpen) { setActionsOpen(false); document.getElementById('skill-actions-btn')?.focus() } else changeView('summary') } : undefined}
      footer={<div id="skill-summary-footer" aria-busy={busy} inert={busy} className="flex flex-col gap-2">
        {view === 'summary' ? <>{boardAction || <button id="open-skill-tasks-btn" onClick={() => changeView('tasks', 'open-skill-tasks-btn')} className="rounded-lg bg-blue-600 hover:bg-blue-500 py-2 text-sm text-white">{tasksLabel}</button>}
          {(onUpdateOutcome || settings) && <button id="edit-skill-btn" onClick={() => changeView('edit', 'edit-skill-btn')} className="rounded-lg border border-slate-700 py-2 text-sm hover:bg-slate-800">{editLabel}</button>}
        </> : <button id="btn-back-skill-summary" onClick={() => changeView('summary')} className="rounded-lg border border-slate-700 py-2 text-sm hover:bg-slate-800">Back to Skill summary</button>}
      </div>}>
    {feedback && <div className="px-4 py-3 border-b border-slate-800 space-y-2">{feedback}</div>}
    <section
      inert={busy}
      aria-busy={busy}
      id="skill-detail-panel"
      ref={bodyRef}
      data-view={view}
      data-selected-skill-id={selectedSkill.id}
      data-connections={JSON.stringify(connections)}
      data-connections-count={connections.length}
      className="p-4 md:p-6 flex flex-col gap-6"
    >
      <div className="space-y-6">
        {/* Header & Badges */}
        <div>
          <div className="flex items-center justify-between gap-2 mb-2">
            <span
              id="skill-selection-badge"
              className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-500/10 text-blue-400 border border-blue-500/20"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
              Skill
            </span>
          </div>

          <div className="flex items-start justify-between gap-3">
            <h2 id="selected-skill-title" className="min-w-0 break-words text-xl font-bold text-slate-100 tracking-tight">
              {selectedSkill.title}
            </h2>
            {view === 'summary' && skillActions && <div className="relative shrink-0">
              <button id="skill-actions-btn" aria-label="Skill actions" aria-expanded={actionsOpen} aria-controls={actionsOpen ? 'skill-actions-menu' : undefined} onClick={() => setActionsOpen(!actionsOpen)} className="rounded-lg border border-slate-700 px-3 py-1 text-slate-300 hover:bg-slate-800 focus-visible:outline focus-visible:outline-blue-400">⋯</button>
              {actionsOpen && <div id="skill-actions-menu" role="group" aria-label="Skill actions" className="absolute right-0 top-full z-10 mt-2 w-56 max-w-[calc(100vw-3rem)] rounded-xl border border-slate-700 bg-slate-900 p-3 shadow-xl flex flex-col gap-2">{skillActions}</div>}
            </div>}
          </div>
          <span id="selected-skill-id" hidden>{selectedSkill.id}</span>
        </div>

        {/* Cycle Rejection Alert */}
        {connectionRejection && (
          <div
            id="cycle-rejection-alert"
            data-kind={connectionRejectionKind(connectionRejection)}
            className="bg-amber-950/60 border border-amber-800/80 rounded-xl p-3 text-xs text-amber-200 flex flex-col gap-1.5 shadow"
          >
            <div className="flex items-center justify-between">
              <span className="font-semibold text-amber-400 flex items-center gap-1">
                ⚠️ Connection Rejected
              </span>
              {onClearRejection && (
                <button
                  onClick={onClearRejection}
                  className="text-amber-400 hover:text-amber-200 cursor-pointer font-bold"
                >
                  ✕
                </button>
              )}
            </div>
            <p className="text-[11px] leading-relaxed text-amber-300/90">{
              // Engine diagnostics are rewritten by title; the application's own refusals are already user language.
              isConnectionRejection(connectionRejection) ? connectionRejectionMessage(connectionRejection, allSkills) : connectionRejection
            }</p>
          </div>
        )}

        {/* Learning Outcome */}
        {(view === 'summary' || view === 'edit') && <div className="bg-slate-800/40 rounded-xl p-4 border border-slate-700/40">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1.5">
            Learning Outcome
          </h4>
          {view === 'edit' && onUpdateOutcome ? (
            <textarea
              id="skill-outcome-input"
              aria-label="Learning outcome"
              value={activeOutcome}
              onChange={(e) => onUpdateOutcome(e.target.value)}
              rows={3}
              className="w-full text-sm text-slate-200 bg-slate-950 border border-slate-700/80 rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-blue-500 resize-none leading-relaxed"
              placeholder="What the learner can do once this Skill is mastered…"
            />
          ) : (
            <p id="skill-summary-outcome" className="text-sm text-slate-300 leading-relaxed whitespace-pre-wrap">
              {activeOutcome || 'No learning outcome yet.'}
            </p>
          )}
        </div>}

        {view === 'summary' && <>
          {learning ?? <div className="space-y-2 text-xs text-slate-400"><p>Access: Not tracked in this view</p><p>Mastery: Not tracked in this view</p></div>}
          <p id="skill-task-count" className="text-sm text-slate-300">{activeTasks.length} Tasks</p>
          <div className="text-xs text-slate-300"><h4 className="font-semibold">Requires</h4><p>{incomingPrereqs.map((c) => allSkills.find((s) => s.id === c.from_id)?.title ?? 'Unavailable Skill').join(', ') || 'No prerequisites'}</p></div>
          <details className="text-xs text-slate-400"><summary className="cursor-pointer">Prerequisite for ({outgoingDependents.length})</summary><p className="mt-2">{outgoingDependents.map((c) => allSkills.find((s) => s.id === c.to_id)?.title ?? 'Unavailable Skill').join(', ') || 'No dependent Skills'}</p></details>
          {(onConnect || onDisconnect) && <button id="manage-prerequisites-btn" onClick={() => changeView('prerequisites', 'manage-prerequisites-btn')} className="text-xs text-blue-300 text-left">Manage prerequisites</button>}
          {history && <button id="skill-history-btn" onClick={() => changeView('history', 'skill-history-btn')} className="text-xs text-slate-300 text-left">History</button>}
        </>}
        {view === 'edit' && settings}
        {view === 'history' && history}

        {/* Prerequisite Connections Section */}
        {view === 'prerequisites' && <div id="skill-prerequisites-section" className="space-y-3">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400 flex items-center justify-between">
            <span>Relationships</span>
          </h4>

          {/* Upstream Prerequisites Required for this Skill */}
          <div className="bg-slate-800/30 rounded-lg p-3 border border-slate-700/30 space-y-2">
            <div className="text-[11px] font-medium text-slate-300">
              This Skill requires…
            </div>
            {incomingPrereqs.length > 0 ? (
              <ul id="incoming-prerequisites-list" className="space-y-1.5">
                {incomingPrereqs.map((c) => {
                  const prereqSkill = allSkills.find((s) => s.id === c.from_id)
                  return (
                    <ConnectionListItem
                      key={c.from_id}
                      fromId={c.from_id}
                      toId={c.to_id}
                      title={prereqSkill?.title ?? 'Unavailable Skill'}
                      direction="←"
                      onDisconnect={onDisconnect}
                    />
                  )
                })}
              </ul>
            ) : (
              <div className="text-[11px] text-slate-500 italic">
                No prerequisites (Foundation Skill).
              </div>
            )}
          </div>

          {/* Downstream Skills Dependent on this Skill */}
          <div className="bg-slate-800/30 rounded-lg p-3 border border-slate-700/30 space-y-2">
            <div className="text-[11px] font-medium text-slate-300">
              This Skill is a prerequisite for…
            </div>
            {outgoingDependents.length > 0 ? (
              <ul id="outgoing-prerequisites-list" className="space-y-1.5">
                {outgoingDependents.map((c) => {
                  const depSkill = allSkills.find((s) => s.id === c.to_id)
                  return (
                    <ConnectionListItem
                      key={c.to_id}
                      fromId={c.from_id}
                      toId={c.to_id}
                      title={depSkill?.title ?? 'Unavailable Skill'}
                      direction="→"
                      onDisconnect={onDisconnect}
                    />
                  )
                })}
              </ul>
            ) : (
              <div className="text-[11px] text-slate-500 italic">
                No downstream dependents yet.
              </div>
            )}
          </div>

          {/* Connect Action Form */}
          {otherSkills.length > 0 && onConnect && (
            <div className="pt-2 flex flex-col gap-2">
              <label htmlFor="connect-skill-select" className="text-[11px] text-slate-400">
                Connect with Skill:
              </label>
              <select
                id="connect-skill-select"
                value={validTargetId}
                onChange={(e) => setSelectedTargetId(e.target.value)}
                className="w-full text-xs bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-slate-200 focus:outline-none focus:border-blue-500"
              >
                {otherSkills.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </select>

              <div className="grid grid-cols-2 gap-2">
                <button
                  id="btn-add-prerequisite"
                  onClick={() => validTargetId && onConnect(validTargetId, selectedSkill.id)}
                  disabled={!validTargetId}
                  className="px-2 py-1.5 bg-blue-600/20 hover:bg-blue-600/30 text-blue-300 border border-blue-500/40 rounded-lg text-xs font-medium transition-colors cursor-pointer text-center disabled:opacity-50 disabled:cursor-not-allowed"
                  title="Make selected option a prerequisite for this skill"
                >
                  This Skill requires selected Skill
                </button>
                <button
                  id="btn-add-dependent"
                  onClick={() => validTargetId && onConnect(selectedSkill.id, validTargetId)}
                  disabled={!validTargetId}
                  className="px-2 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg text-xs font-medium transition-colors cursor-pointer text-center disabled:opacity-50 disabled:cursor-not-allowed"
                  title="Make this skill a prerequisite for selected option"
                >
                  Selected Skill requires this Skill
                </button>
              </div>
            </div>
          )}
        </div>}

        {/* Task controls are mounted only for callers without a board. */}
        {view === 'tasks' && !boardAction && <div>
          <div className="mb-2 flex items-center justify-between">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Tasks
            </h4>
          </div>

          {activeTasks.length > 0 ? (
            <div id="associated-tasks-list" className="space-y-3">
              {activeTasks.map((task) => (
                <div
                  key={task.id}
                  id={`task-container-${task.id}`}
                  className="rounded-xl bg-slate-800/40 p-3.5 border border-slate-700/50 space-y-2.5 transition-colors focus-within:border-blue-500/50"
                >
                  {!tasksEditable && (
                    <div className="space-y-1">
                      <div className="flex items-start justify-between gap-2">
                        <h5 id={`task-title-${task.id}`} className="text-xs font-semibold text-slate-100">{task.title}</h5>
                        {task.required !== undefined && <span
                          id={`task-badge-${task.id}`}
                          className={`shrink-0 text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded ${
                            task.required
                              ? 'text-amber-400 bg-amber-400/10 border border-amber-400/20'
                              : 'text-slate-400 bg-slate-800 border border-slate-700'
                          }`}
                        >
                          {task.required ? 'Required' : 'Enrichment'}
                        </span>}
                      </div>
                      {task.description && <p id={`task-description-${task.id}`} className="text-xs text-slate-300 leading-relaxed whitespace-pre-wrap">{task.description}</p>}
                    </div>
                  )}
                  {tasksEditable && <>
                  <div className="flex items-center justify-between gap-2">
                    <label
                      htmlFor={`task-edit-title-${task.id}`}
                      className="text-[11px] font-semibold text-slate-300 font-mono"
                    >
                      Task Title:
                    </label>
                    {task.required !== undefined && <span
                      id={`task-badge-${task.id}`}
                      className={`text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded ${
                        task.required
                          ? 'text-amber-400 bg-amber-400/10 border border-amber-400/20'
                          : 'text-slate-400 bg-slate-800 border border-slate-700'
                      }`}
                    >
                      {task.required ? 'Required' : 'Enrichment'}
                    </span>}
                  </div>

                  <input
                    id={`task-edit-title-${task.id}`}
                    type="text"
                    value={task.title}
                    onChange={(e) =>
                      onUpdateTask?.(task.id, { title: e.target.value })
                    }
                    className="w-full text-xs font-medium text-slate-100 bg-slate-950 border border-slate-700/80 rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-blue-500"
                    placeholder="Task title..."
                  />

                  <div>
                    <label
                      htmlFor={`task-edit-description-${task.id}`}
                      className="block text-[11px] text-slate-400 mb-1"
                    >
                      Description / Learning Goal:
                    </label>
                    <textarea
                      id={`task-edit-description-${task.id}`}
                      value={task.description}
                      onChange={(e) =>
                        onUpdateTask?.(task.id, { description: e.target.value })
                      }
                      rows={2}
                      className="w-full text-xs text-slate-300 bg-slate-950 border border-slate-700/80 rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-blue-500 resize-none leading-relaxed"
                      placeholder="Task description..."
                    />
                  </div>

                  {task.required !== undefined && <div className="pt-1 flex items-center justify-between">
                    <label
                      htmlFor={`task-edit-required-${task.id}`}
                      className="flex items-center gap-2 cursor-pointer select-none text-[11px] text-slate-300"
                    >
                      <input
                        id={`task-edit-required-${task.id}`}
                        type="checkbox"
                        checked={task.required}
                        onChange={(e) =>
                          onUpdateTask?.(task.id, { required: e.target.checked })
                        }
                        className="rounded border-slate-700 bg-slate-900 text-blue-500 focus:ring-0 cursor-pointer"
                      />
                      <span>Is Required Task (Mandatory for Skill Mastery)</span>
                    </label>
                  </div>}
                  </>}
                  {renderTaskExtra?.(task.id)}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-xs text-slate-500 italic py-2">
              No tasks assigned yet to this skill definition.
            </div>
          )}
          {onAddTask && (
            <button
              id="add-task-btn"
              onClick={onAddTask}
              className="mt-3 w-full px-2 py-1.5 bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/40 rounded-lg text-xs font-medium transition-colors cursor-pointer"
            >
              + Add Task
            </button>
          )}
        </div>}
      </div>

    </section>
    </TemporaryPanel>
  )
}
