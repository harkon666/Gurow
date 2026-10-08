import { useState, type FormEvent } from 'react'
import type { LearningAction, LearningSkill, LearningState, LearningTask, XpEvent } from '../../lib/api'
import type { LearningView } from './learning'

/**
 * Personal learning panels (ADR 0001, 0009): Access, XP and Mastery are shown as
 * three separate things, and each change is a separate owner action. Everything
 * shown comes from the backend's last confirmed answer.
 */

export type PersonalLearningView = LearningView<LearningState, LearningAction>

const titleOf = (skillTitles: Map<string, string>, id: string) => skillTitles.get(id) ?? 'an unknown Skill'

/** Why a Skill is locked under the current rules; an override waives these without removing them. */
export function lockReasons(skill: LearningSkill, xp: number, skillTitles: Map<string, string>): string[] {
  const reasons = skill.unmetPrerequisiteSkillIds.map((id) => `Requires Mastery of “${titleOf(skillTitles, id)}”, which is not declared`)
  if (skill.xpShortfall > 0) reasons.push(`Needs ${skill.xpShortfall} more XP: the threshold is ${skill.xpThreshold} and this Path has ${xp} XP`)
  return reasons
}

export type AccessKind = 'open' | 'locked' | 'override'
export const accessKind = (skill: LearningSkill): AccessKind => !skill.access ? 'locked' : skill.accessOverride ? 'override' : 'open'
const ACCESS_TEXT: Record<AccessKind, string> = { open: 'Open', locked: 'Locked', override: 'Open by override' }

/** Describes an action in the owner's terms, for pending and failure messages. */
export function describeAction(action: LearningAction, taskTitles: Map<string, string>, skillTitles: Map<string, string>) {
  const task = 'taskId' in action ? `“${taskTitles.get(action.taskId) ?? 'Task'}”` : ''
  const skill = 'skillId' in action ? `“${titleOf(skillTitles, action.skillId)}”` : ''
  switch (action.kind) {
    case 'complete': return `Marking ${task} complete`
    case 'undo-completion': return `Undoing completion of ${task}`
    case 'reward': return `Setting the reward of ${task} to ${action.xpReward} XP`
    case 'mastery': return action.on ? `Declaring Mastery of ${skill}` : `Withdrawing the Mastery declaration of ${skill}`
    case 'override': return action.on ? `Bypassing the gates of ${skill}` : `Removing the bypass of ${skill}`
    case 'threshold': return `Setting the XP Threshold of ${skill} to ${action.xpThreshold}`
  }
}

/** One recorded XP change, worded as what the owner did and what it did to the total. */
export function describeXpEvent(event: XpEvent, taskTitles: Map<string, string>) {
  const task = `“${taskTitles.get(event.taskId) ?? 'Task'}”`
  const amount = `${event.amount > 0 ? '+' : '−'}${Math.abs(event.amount)} XP`
  const what = event.cause === 'reward_change' ? `${task} reward changed while complete`
    : event.cause === 'completion_undone' ? `${task} completion undone`
    : event.kind === 'award' ? `${task} completed` : `${task} completed again`
  return `${what}: ${amount} (${event.kind === 'award' ? 'award' : 'correction'})`
}

/** A whole-number field with its own Set button; the value shown elsewhere stays the confirmed one. */
function NumberSetter({ id, label, value, disabled, onSet }: { id: string; label: string; value: number; disabled: boolean; onSet: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value))
  const parsed = Number(draft)
  const valid = draft.trim() !== '' && Number.isSafeInteger(parsed) && parsed >= 0
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (valid && parsed !== value) onSet(parsed)
  }
  return (
    <form onSubmit={submit} className="flex items-center gap-2">
      <label htmlFor={id} className="text-[11px] text-slate-400 shrink-0">{label}</label>
      <input
        id={id}
        type="number"
        min={0}
        step={1}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        className="w-20 text-xs text-slate-100 bg-slate-950 border border-slate-700/80 rounded px-2 py-1 focus:outline-none focus:border-blue-500"
      />
      <button
        id={`${id}-set`}
        type="submit"
        disabled={disabled || !valid || parsed === value}
        className="text-[11px] text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded px-2 py-1 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Set
      </button>
    </form>
  )
}

interface SkillLearningProps {
  view: PersonalLearningView
  skillId: string
  skillTitles: Map<string, string>
  taskTitles: Map<string, string>
  onAction: (action: LearningAction) => void
  section?: 'summary' | 'settings' | 'history'
}

/** Access, Mastery and the XP Threshold of the selected Skill, with this Skill's XP record. */
export function SkillLearning({ view, skillId, skillTitles, taskTitles, onAction, section = 'summary' }: SkillLearningProps) {
  const records = view.records
  const skill = records?.skills.find((s) => s.skillId === skillId)
  if (!records || !skill) {
    return (
      <div id="skill-learning" data-tracked="false" className="text-[11px] text-slate-500 italic bg-slate-800/30 rounded-xl p-3 border border-slate-700/30">
        {records ? 'Access, Mastery and XP can be tracked once this Skill is saved.' : 'Loading learning records…'}
      </div>
    )
  }
  const busy = view.pending !== null
  const kind = accessKind(skill)
  const reasons = lockReasons(skill, records.xp, skillTitles)
  const events = records.xpHistory.filter((event) => records.tasks.find((t) => t.taskId === event.taskId)?.skillId === skillId)
  return (
    <div id="skill-learning" data-tracked="true" className="space-y-3">
      {section !== 'history' && <section id="skill-access" data-access={kind} aria-labelledby="skill-access-heading" className={`rounded-xl p-3 border ${kind === 'locked' ? 'bg-red-950/30 border-red-900/60' : 'bg-emerald-950/20 border-emerald-900/50'}`}>
        <div className="flex items-center justify-between gap-2">
          <h4 id="skill-access-heading" className="text-xs font-semibold uppercase tracking-wider text-slate-400">Access</h4>
          <span id="skill-access-state" className={`text-xs font-semibold ${kind === 'locked' ? 'text-red-300' : 'text-emerald-300'}`}>{ACCESS_TEXT[kind]}</span>
        </div>
        {reasons.length > 0 && (
          <ul id="lock-reasons" aria-label={kind === 'override' ? 'Requirements waived by the override' : 'Why this Skill is locked'} className="mt-2 space-y-1 text-[11px] text-slate-300 list-disc pl-4">
            {reasons.map((reason) => <li key={reason}>{reason}</li>)}
          </ul>
        )}
        {kind === 'override' && reasons.length > 0 && <p className="mt-1 text-[10px] text-slate-500">These requirements are waived by your override.</p>}
        {section === 'settings' && <div className="mt-2 flex flex-col gap-1.5">
          {/* Keyed by Skill too: a draft typed for one Skill must not follow the selection to another. */}
          <NumberSetter key={`threshold:${skillId}:${skill.xpThreshold}`} id="xp-threshold-input" label="XP Threshold" value={skill.xpThreshold} disabled={busy} onSet={(xpThreshold) => onAction({ kind: 'threshold', skillId, xpThreshold })} />
          <p className="text-[10px] text-slate-500">Uses only XP from this Path. Reaching it spends no XP.</p>
          <button
            id="access-override-btn"
            disabled={busy}
            onClick={() => onAction({ kind: 'override', skillId, on: !skill.accessOverride })}
            className="self-start text-[11px] text-amber-100 bg-amber-900/40 hover:bg-amber-800/50 border border-amber-800/70 rounded px-2 py-1 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {skill.accessOverride ? 'Remove bypass' : 'Bypass Prerequisites and XP Threshold'}
          </button>
          <p className="text-[10px] text-slate-500">No reason needed. A bypass changes no XP or Mastery.</p>
        </div>}
      </section>}

      {section === 'summary' && <section id="skill-mastery" data-mastery={skill.mastery ? 'declared' : 'unclaimed'} aria-labelledby="skill-mastery-heading" className="rounded-xl p-3 border bg-slate-800/40 border-slate-700/40">
        <div className="flex items-center justify-between gap-2">
          <h4 id="skill-mastery-heading" className="text-xs font-semibold uppercase tracking-wider text-slate-400">Mastery</h4>
          <span id="skill-mastery-state" className={`text-xs font-semibold ${skill.mastery ? 'text-violet-300' : 'text-slate-400'}`}>{skill.mastery ? 'Declared' : 'Unclaimed'}</span>
        </div>
        <button
          id="mastery-btn"
          disabled={busy}
          onClick={() => onAction({ kind: 'mastery', skillId, on: !skill.mastery })}
          className="mt-2 text-[11px] text-violet-100 bg-violet-900/40 hover:bg-violet-800/50 border border-violet-800/70 rounded px-2 py-1 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {skill.mastery ? 'Withdraw Mastery declaration' : 'Declare Mastery'}
        </button>
        <p className="mt-1 text-[10px] text-slate-500">Your own judgement: no evidence or review needed. Completing Tasks never declares it, and declaring it earns no XP.</p>
      </section>}

      {section === 'history' && <section id="skill-xp-record" aria-label="XP record of this Skill" className="rounded-xl p-3 border bg-slate-800/30 border-slate-700/30">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">XP record</h4>
        {events.length === 0 ? (
          <p className="mt-1 text-[11px] text-slate-500 italic">No XP recorded for this Skill's Tasks yet.</p>
        ) : (
          <ol id="xp-history" className="mt-1 space-y-0.5 text-[11px] text-slate-300">
            {events.map((event) => <li key={event.id} data-kind={event.kind} data-amount={event.amount}>{describeXpEvent(event, taskTitles)}</li>)}
          </ol>
        )}
      </section>}
      {section === 'history' && <>
        <section aria-label="Mastery history" className="rounded-xl border border-slate-700/40 p-3">
          <h4 className="text-xs font-semibold text-slate-400">Mastery history</h4>
          <ol id="skill-mastery-history" className="mt-2 space-y-1 text-[11px] text-slate-300">
            {records.masteryHistory.filter((event) => event.skillId === skillId).map((event) => <li key={event.id} data-action={event.action}>{event.action === 'declare' ? 'Mastery declared' : 'Mastery declaration withdrawn'} · {new Date(event.occurredAt).toLocaleString()}</li>)}
          </ol>
        </section>
        <section aria-label="Access Override history" className="rounded-xl border border-slate-700/40 p-3">
          <h4 className="text-xs font-semibold text-slate-400">Access Override history</h4>
          <ol id="skill-override-history" className="mt-2 space-y-1 text-[11px] text-slate-300">
            {records.overrideHistory.filter((event) => event.skillId === skillId).map((event, index) => <li key={`${event.occurredAt}:${index}`} data-action={event.action}>{event.action === 'grant' ? 'Access Override granted' : 'Access Override revoked'} · {new Date(event.occurredAt).toLocaleString()}</li>)}
          </ol>
        </section>
      </>}
    </div>
  )
}

/** Completion and reward of one Task, inside its Task card. */
export function TaskLearning({ view, taskId, onAction, prefix = '' }: {
  view: PersonalLearningView
  taskId: string
  onAction: (action: LearningAction) => void
  /** Keeps IDs unique where the same Task's controls are shown twice (the board's details over the Skill summary). */
  prefix?: string
}) {
  const records = view.records
  const task: LearningTask | undefined = records?.tasks.find((t) => t.taskId === taskId)
  if (!records || !task) {
    return <p id={`${prefix}task-learning-${taskId}`} data-tracked="false" className="text-[10px] text-slate-500 italic">Completion and reward can be tracked once this Task is saved.</p>
  }
  const skill = records.skills.find((s) => s.skillId === task.skillId)
  const locked = !skill?.access
  const busy = view.pending !== null
  return (
    <div id={`${prefix}task-learning-${taskId}`} data-tracked="true" data-completed={task.completed} className="pt-2 border-t border-slate-700/40 space-y-1.5">
      <NumberSetter key={`reward:${task.xpReward}`} id={`${prefix}task-reward-${taskId}`} label="Reward (XP)" value={task.xpReward} disabled={busy} onSet={(xpReward) => onAction({ kind: 'reward', taskId, xpReward })} />
      <div className="flex items-center justify-between gap-2">
        <span id={`${prefix}task-contribution-${taskId}`} className={`text-[11px] ${task.completed ? 'text-emerald-300' : 'text-slate-400'}`}>
          {task.completed ? `Complete · contributes ${task.xpContribution} XP` : 'Not complete · contributes 0 XP'}
        </span>
        <button
          id={`${prefix}task-completion-btn-${taskId}`}
          disabled={busy || (!task.completed && locked)}
          onClick={() => onAction({ kind: task.completed ? 'undo-completion' : 'complete', taskId })}
          className="text-[11px] text-emerald-100 bg-emerald-900/40 hover:bg-emerald-800/50 border border-emerald-800/70 rounded px-2 py-1 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {task.completed ? 'Undo completion' : 'Mark complete'}
        </button>
      </div>
      {!task.completed && locked && <p id={`${prefix}task-locked-${taskId}`} className="text-[10px] text-red-300/90">This Skill is locked: completing its Tasks waits for Access. Undoing a completion is always possible.</p>}
      <p className="text-[10px] text-slate-500">Evidence and review are optional. Completing does not declare Mastery.</p>
    </div>
  )
}

/** The Path's own XP and the state of the last learning action, beside the save status. */
export function LearningStatus({ view, describe, onRetry, onDismiss, onReload }: {
  view: PersonalLearningView
  describe: (action: LearningAction) => string
  onRetry: () => void
  onDismiss: () => void
  onReload: () => void
}) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span id="path-xp" data-xp={view.records?.xp ?? ''} title="XP earned in this Path only; other Paths do not count" className="px-2 py-1 rounded-lg border border-sky-800/60 text-sky-200 bg-slate-950/80">
        {view.records ? `Path XP ${view.records.xp}` : 'Path XP …'}
      </span>
      {view.pending && <span id="learning-pending" role="status" className="text-slate-400">{describe(view.pending)}…</span>}
      {view.failed && (
        <div id="learning-error" role="alert" className="flex items-center gap-2 text-red-300">
          <span className="max-w-[24rem] truncate" title={view.failed.detail}>Not recorded: {describe(view.failed.action)} failed ({view.failed.detail}).</span>
          <button id="learning-retry-btn" onClick={onRetry} className="text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2 py-1 rounded-lg cursor-pointer">Retry</button>
          <button id="learning-dismiss-btn" onClick={onDismiss} aria-label="Dismiss" className="text-slate-400 hover:text-slate-200 cursor-pointer">✕</button>
        </div>
      )}
      {view.loadError && !view.failed && (
        <div id="learning-load-error" role="alert" className="flex items-center gap-2 text-red-300">
          <span>Learning records could not be loaded ({view.loadError}).</span>
          <button id="learning-reload-btn" onClick={onReload} className="text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2 py-1 rounded-lg cursor-pointer">Reload</button>
        </div>
      )}
    </div>
  )
}

/** The short status of a Skill in the keyboard list: Access and Mastery, never merged. */
export function SkillStatusChips({ skill }: { skill: LearningSkill | undefined }) {
  if (!skill) return null
  const kind = accessKind(skill)
  return (
    <span id={`skill-status-${skill.skillId}`} data-access={kind} data-mastery={skill.mastery ? 'declared' : 'unclaimed'} className="flex gap-1 text-[9px] font-mono">
      <span className={`px-1 rounded border ${kind === 'locked' ? 'text-red-300 border-red-900/70' : 'text-emerald-300 border-emerald-900/70'}`}>{ACCESS_TEXT[kind]}</span>
      {skill.mastery && <span className="px-1 rounded border text-violet-300 border-violet-900/70">Mastery declared</span>}
    </span>
  )
}
