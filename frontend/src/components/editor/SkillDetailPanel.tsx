import React, { useState } from 'react'
import { INITIAL_LEARNING_PATH_FIXTURE, type FixtureTask } from '../../fixtures/learningPath'
import type { SelectedSkillInfo } from './types'
import type { PrerequisiteConnection } from './protocol'

interface SkillDetailPanelProps {
  selectedSkill: SelectedSkillInfo | null
  connections?: PrerequisiteConnection[]
  allSkills?: Array<{ id: string; title: string }>
  onConnect?: (fromId: string, toId: string) => void
  onDisconnect?: (fromId: string, toId: string) => void
  connectionRejection?: string | null
  onClearRejection?: () => void
  tasks?: FixtureTask[]
  outcome?: string
  onUpdateTask?: (taskId: string, updates: Partial<FixtureTask>) => void
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
  connections = [],
  allSkills = INITIAL_LEARNING_PATH_FIXTURE.skills.map((s) => ({ id: s.id, title: s.title })),
  onConnect,
  onDisconnect,
  connectionRejection,
  onClearRejection,
  tasks,
  outcome,
  onUpdateTask,
}) => {
  const [selectedTargetId, setSelectedTargetId] = useState<string>('')

  // Reset selectedTargetId whenever the active skill selection changes
  React.useEffect(() => {
    setSelectedTargetId('')
  }, [selectedSkill?.id])

  if (!selectedSkill) {
    return (
      <aside
        id="skill-detail-panel"
        data-connections={JSON.stringify(connections)}
        data-connections-count={connections.length}
        className="w-80 shrink-0 h-full border-l border-slate-800 bg-slate-900/60 p-6 flex flex-col justify-center items-center text-center text-slate-400 backdrop-blur-md select-none"
      >
        <div className="w-14 h-14 rounded-2xl bg-slate-800/80 flex items-center justify-center mb-4 text-slate-500 border border-slate-700/50 shadow-inner">
          <svg
            className="w-7 h-7"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656l-2.12 2.122"
            />
          </svg>
        </div>
        <h3 className="text-base font-medium text-slate-200 mb-1">
          No Skill Selected
        </h3>
        <p className="text-xs text-slate-500 max-w-[220px]">
          Click any card on the WebGPU canvas to view its details, prerequisites, and associated tasks.
        </p>
      </aside>
    )
  }

  // Lookup learning metadata from props or application fixture; title is authoritative from engine
  const fixtureSkill = INITIAL_LEARNING_PATH_FIXTURE.skills.find(
    (s) => s.id === selectedSkill.id
  )

  const activeOutcome = outcome ?? fixtureSkill?.outcome ?? ''
  const activeTasks = tasks ?? fixtureSkill?.tasks ?? []

  // Derived prerequisite connections for this skill
  const incomingPrereqs = connections.filter((c) => c.to_id === selectedSkill.id)
  const outgoingDependents = connections.filter((c) => c.from_id === selectedSkill.id)

  const otherSkills = allSkills.filter((s) => s.id !== selectedSkill.id)
  // Ensure validTargetId strictly belongs to otherSkills, preventing self-connection or stale targets
  const validTargetId =
    otherSkills.find((s) => s.id === selectedTargetId)?.id ?? (otherSkills[0]?.id ?? '')

  return (
    <aside
      id="skill-detail-panel"
      data-connections={JSON.stringify(connections)}
      data-connections-count={connections.length}
      className="w-80 shrink-0 h-full border-l border-slate-800 bg-slate-900/80 p-6 flex flex-col gap-6 backdrop-blur-md overflow-y-auto"
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
              Selected in WebGPU
            </span>
          </div>

          <h2
            id="selected-skill-title"
            className="text-xl font-bold text-slate-100 tracking-tight"
          >
            {selectedSkill.title}
          </h2>

          <div className="mt-1 flex items-center gap-1.5 text-xs text-slate-500 font-mono">
            <span>ID:</span>
            <code
              id="selected-skill-id"
              className="bg-slate-800/80 px-1.5 py-0.5 rounded text-blue-300 font-mono text-[11px]"
            >
              {selectedSkill.id}
            </code>
          </div>
        </div>

        {/* Cycle Rejection Alert */}
        {connectionRejection && (
          <div
            id="cycle-rejection-alert"
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
            <p className="text-[11px] leading-relaxed text-amber-300/90">{connectionRejection}</p>
          </div>
        )}

        {/* Learning Outcome */}
        <div className="bg-slate-800/40 rounded-xl p-4 border border-slate-700/40">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1.5">
            Learning Outcome
          </h4>
          <p className="text-sm text-slate-300 leading-relaxed">
            {activeOutcome}
          </p>
        </div>

        {/* Prerequisite Connections Section */}
        <div id="skill-prerequisites-section" className="space-y-3">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400 flex items-center justify-between">
            <span>Prerequisite Graph (DAG)</span>
            <span className="text-[10px] text-blue-400/90 font-mono">Rust Owned</span>
          </h4>

          {/* Upstream Prerequisites Required for this Skill */}
          <div className="bg-slate-800/30 rounded-lg p-3 border border-slate-700/30 space-y-2">
            <div className="text-[11px] font-medium text-slate-300">
              Requires (Prerequisites):
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
                      title={prereqSkill?.title ?? c.from_id}
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
              Prerequisite For (Dependents):
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
                      title={depSkill?.title ?? c.to_id}
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
                  + As Prerequisite
                </button>
                <button
                  id="btn-add-dependent"
                  onClick={() => validTargetId && onConnect(selectedSkill.id, validTargetId)}
                  disabled={!validTargetId}
                  className="px-2 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg text-xs font-medium transition-colors cursor-pointer text-center disabled:opacity-50 disabled:cursor-not-allowed"
                  title="Make this skill a prerequisite for selected option"
                >
                  + As Dependent
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Associated Tasks (Application-owned, ADR-0015 & Ticket T04 AC 1) */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Associated Tasks
            </h4>
            <span className="text-[10px] text-emerald-400/90 font-mono bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20">
              React Domain Payload
            </span>
          </div>

          <div className="text-[10px] text-slate-500 mb-3 italic">
            Task contents belong to application state and are not included in engine canvas snapshots.
          </div>

          {activeTasks.length > 0 ? (
            <div id="associated-tasks-list" className="space-y-3">
              {activeTasks.map((task) => (
                <div
                  key={task.id}
                  id={`task-container-${task.id}`}
                  className="rounded-xl bg-slate-800/40 p-3.5 border border-slate-700/50 space-y-2.5 transition-colors focus-within:border-blue-500/50"
                >
                  <div className="flex items-center justify-between gap-2">
                    <label
                      htmlFor={`task-edit-title-${task.id}`}
                      className="text-[11px] font-semibold text-slate-300 font-mono"
                    >
                      Task Title:
                    </label>
                    <span
                      id={`task-badge-${task.id}`}
                      className={`text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded ${
                        task.required
                          ? 'text-amber-400 bg-amber-400/10 border border-amber-400/20'
                          : 'text-slate-400 bg-slate-800 border border-slate-700'
                      }`}
                    >
                      {task.required ? 'Required' : 'Enrichment'}
                    </span>
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

                  <div className="pt-1 flex items-center justify-between">
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
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-xs text-slate-500 italic py-2">
              No tasks assigned yet to this skill definition.
            </div>
          )}
        </div>
      </div>

      {/* Footer Info */}
      <div className="pt-4 border-t border-slate-800/60 text-[11px] text-slate-500 flex justify-between items-center mt-auto shrink-0">
        <span>Owner: Rust Engine</span>
        <span>Render: WebGPU</span>
      </div>
    </aside>
  )
}
