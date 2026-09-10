import React from 'react'
import { INITIAL_LEARNING_PATH_FIXTURE } from '../../fixtures/learningPath'
import type { SelectedSkillInfo } from './types'

interface SkillDetailPanelProps {
  selectedSkill: SelectedSkillInfo | null
}

export const SkillDetailPanel: React.FC<SkillDetailPanelProps> = ({
  selectedSkill,
}) => {
  if (!selectedSkill) {
    return (
      <aside
        id="skill-detail-panel"
        className="w-80 border-l border-slate-800 bg-slate-900/60 p-6 flex flex-col justify-center items-center text-center text-slate-400 backdrop-blur-md select-none"
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
          Click any card on the WebGPU canvas to view its details and associated tasks.
        </p>
      </aside>
    )
  }

  // Lookup learning metadata from application fixture; title is authoritative from engine
  const fixtureSkill = INITIAL_LEARNING_PATH_FIXTURE.skills.find(
    (s) => s.id === selectedSkill.id
  )

  const outcome = fixtureSkill?.outcome ?? ''
  const tasks = fixtureSkill?.tasks ?? []

  return (
    <aside
      id="skill-detail-panel"
      className="w-80 border-l border-slate-800 bg-slate-900/80 p-6 flex flex-col justify-between backdrop-blur-md overflow-y-auto"
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

        {/* Learning Outcome */}
        <div className="bg-slate-800/40 rounded-xl p-4 border border-slate-700/40">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1.5">
            Learning Outcome
          </h4>
          <p className="text-sm text-slate-300 leading-relaxed">
            {outcome}
          </p>
        </div>

        {/* Associated Tasks (Application-owned) */}
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3 flex items-center justify-between">
            <span>Associated Tasks</span>
            <span className="text-[10px] text-slate-500 font-normal">React Domain Store</span>
          </h4>

          {tasks.length > 0 ? (
            <div className="space-y-2.5">
              {tasks.map((task) => (
                <div
                  key={task.id}
                  className="rounded-lg bg-slate-800/30 p-3 border border-slate-700/30 hover:border-slate-600/50 transition-colors"
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium text-slate-200">
                      {task.title}
                    </span>
                    {task.required ? (
                      <span className="text-[10px] uppercase font-semibold text-amber-400/90 bg-amber-400/10 px-1.5 py-0.5 rounded">
                        Required
                      </span>
                    ) : (
                      <span className="text-[10px] uppercase font-semibold text-slate-400 bg-slate-800 px-1.5 py-0.5 rounded">
                        Enrichment Task
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-400 leading-normal">
                    {task.description}
                  </p>
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
      <div className="pt-4 border-t border-slate-800/60 text-[11px] text-slate-500 flex justify-between items-center">
        <span>Owner: Rust Engine</span>
        <span>Render: WebGPU</span>
      </div>
    </aside>
  )
}
