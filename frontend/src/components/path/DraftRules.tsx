import { useState } from 'react'
import type { PathSkill, PathTask } from '../../lib/api'
import type { PrerequisiteConnection } from '../editor/protocol'

/**
 * A Coach's Draft rules (CONTEXT.md: Optional Skill, Required Task, XP Award, XP
 * Threshold). They are Draft content saved with the document, unlike personal
 * rewards and thresholds, which are the owner's learning records.
 */

const isOptional = (skills: PathSkill[], id: string) => skills.find((skill) => skill.id === id)?.optional === true

/**
 * Why a connection from → to would break the rule that an Optional Skill is never a
 * Prerequisite of a required Skill, or null when it is allowed.
 */
export function optionalPrerequisiteProblem(skills: PathSkill[], from: string, to: string): string | null {
  if (!isOptional(skills, from) || isOptional(skills, to)) return null
  const title = (id: string) => skills.find((skill) => skill.id === id)?.title ?? id
  return `Optional Skill “${title(from)}” cannot be a Prerequisite of required Skill “${title(to)}”.`
}

/** The first connection that breaks the rule, e.g. after an undo restored it. */
export function draftRuleProblem(skills: PathSkill[], connections: PrerequisiteConnection[]) {
  for (const edge of connections) {
    const problem = optionalPrerequisiteProblem(skills, edge.from_id, edge.to_id)
    if (problem) return problem
  }
  return null
}

/** Why the Skill cannot become Optional (it leads to a required Skill) or required (an Optional Skill leads to it). */
export function optionalToggleProblem(skills: PathSkill[], connections: PrerequisiteConnection[], skillId: string, optional: boolean) {
  const next = skills.map((skill) => (skill.id === skillId ? { ...skill, optional } : skill))
  const touching = connections.filter((edge) => edge.from_id === skillId || edge.to_id === skillId)
  return draftRuleProblem(next, touching)
}

/** A whole-number field that keeps what is typed and reports only valid values. */
function DraftNumber({ id, label, value, max, onChange }: { id: string; label: string; value: number; max: number; onChange: (value: number) => void }) {
  const [text, setText] = useState(String(value))
  const parsed = Number(text)
  const valid = text.trim() !== '' && Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= max
  return (
    <label htmlFor={id} className="flex items-center justify-between gap-2 text-[11px] text-slate-300">
      {label}
      <input
        id={id}
        type="number"
        min={0}
        max={max}
        step={1}
        value={text}
        aria-invalid={!valid}
        onChange={(e) => {
          setText(e.target.value)
          const next = Number(e.target.value)
          if (e.target.value.trim() !== '' && Number.isSafeInteger(next) && next >= 0 && next <= max) onChange(next)
        }}
        className={`w-24 text-xs text-slate-100 bg-slate-950 border rounded px-2 py-1 focus:outline-none ${valid ? 'border-slate-700/80 focus:border-blue-500' : 'border-red-700'}`}
      />
    </label>
  )
}

/** Optional/required and the XP Threshold of the selected Skill in a Draft. */
export function SkillDraftRules({ skill, onOptional, onThreshold }: { skill: PathSkill; onOptional: (optional: boolean) => void; onThreshold: (xpThreshold: number) => void }) {
  return (
    <section id="draft-rules" data-optional={skill.optional === true} aria-labelledby="draft-rules-heading" className="bg-slate-800/40 rounded-xl p-4 border border-slate-700/40 space-y-2.5">
      <h4 id="draft-rules-heading" className="text-xs font-semibold uppercase tracking-wider text-slate-400">Draft rules</h4>
      <label htmlFor="skill-optional-input" className="flex items-start gap-2 text-[11px] text-slate-300 cursor-pointer select-none">
        <input
          id="skill-optional-input"
          type="checkbox"
          checked={skill.optional === true}
          onChange={(e) => onOptional(e.target.checked)}
          className="mt-0.5 rounded border-slate-700 bg-slate-900 cursor-pointer"
        />
        <span>
          Optional Skill
          <span className="block text-[10px] text-slate-500">Enrichment learners may skip. It cannot be a Prerequisite of a required Skill.</span>
        </span>
      </label>
      <DraftNumber key={`threshold:${skill.id}`} id="skill-threshold-input" label="XP Threshold" value={skill.xpThreshold ?? 0} max={1_000_000_000} onChange={onThreshold} />
      <p className="text-[10px] text-slate-500">Uses only the learner's XP from their Enrollment. Reaching it spends no XP.</p>
    </section>
  )
}

/** The reward of one Task in a Draft; Required/Enrichment is set on the Task card itself. */
export function TaskDraftRules({ task, onReward }: { task: PathTask; onReward: (xpReward: number) => void }) {
  return (
    <div id={`task-draft-rules-${task.id}`} className="pt-2 border-t border-slate-700/40">
      <DraftNumber key={`reward:${task.id}`} id={`task-xp-reward-${task.id}`} label="Reward (XP)" value={task.xpReward ?? 0} max={1_000_000} onChange={onReward} />
    </div>
  )
}
