import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { WebGpuEditor, type WebGpuEditorActions } from '../editor/WebGpuEditor'
import { SkillDetailPanel } from '../editor/SkillDetailPanel'
import { SkillPrerequisiteList } from '../editor/SkillPrerequisiteList'
import { loadCameraState, saveCameraState } from '../editor/checkpoint'
import type { CameraState } from '../editor/protocol'
import type { GpuStatus, SelectedSkillInfo } from '../editor/types'
import { readEnrollmentLearningState, readTaskSubmission, type AwaitingRevision, type EnrolledVersion, type EnrollmentLearningState, type EnrollmentSkillState, type PathSkill, type SubmissionRevisionView } from '../../lib/api'
import { TaskWork } from './TaskWork'
import { TaskReview } from './TaskReview'
import { revisionNote } from './submissionWork'
import { coachRevisionNote, DECISION_TEXT } from './reviewWork'
import { ApprovalRevocation } from './ApprovalRevocation'
import { masteryEventText, revocationEffect, xpEventText } from './revocationWork'
import { AccessOverrideControl } from './AccessOverrideControl'
import { enrollmentLockReasons, ordinaryRequirements, overrideRecordText, type OverrideNames } from './overrideWork'
import { EnrollmentParticipation } from './EnrollmentParticipation'

/**
 * The Version an Enrollment joined, as its learner navigates it (ADR 0005, 0017): the
 * Coach's shared Canvas Layout, read-only, beside the keyboard Skill/Prerequisite
 * list, with each Skill's outcome and Tasks in the sidebar. Access, Mastery and
 * Enrollment XP are shown as three separate things, exactly as the backend last
 * derived them (ADR 0001); nothing here changes them or the published content.
 * The Coach can change them at any time (a Review, a revocation, a deactivation), so
 * they are read again whenever the page becomes visible or the learner asks.
 * Camera state is stored only locally, per Account and Enrollment. The learner (never
 * the Coach) prepares private work for each Task and sends it from the sidebar (ADR 0002).
 * The owning Coach finds the revisions awaiting Review in a keyboard list, which opens
 * the Task beside its history, and decides there; the records are then read again.
 * The Coach can also revoke an Approval from the history, with a reason; both see what
 * the revocation changed, as the backend recorded it (ADR 0003). From a Skill's Access, the
 * Coach grants or revokes an Access Override with a reason; both read every Override Record.
 * Below the header, the learner can stop participating and the Coach can deactivate or
 * reactivate the Enrollment (ADR 0014); everything stays readable while it is inactive.
 */

/** The learning records as last confirmed by the backend; a failed read keeps them and says so. */
interface RecordsView {
  records: EnrollmentLearningState | null
  /** When the shown records were read. */
  readAt: Date | null
  /** Counts confirmed reads, so the Submission histories on show are read again with each. */
  generation: number
  reading: boolean
  error: string | null
}

/** The camera's local storage context: one per Enrollment, so it never moves another Path's or Account's view. */
export const enrollmentCameraContext = (enrollmentId: string) => `enrollment:${enrollmentId}`

type AccessKind = 'open' | 'locked' | 'override'
const accessKind = (skill: EnrollmentSkillState): AccessKind => !skill.access ? 'locked' : skill.accessOverride ? 'override' : 'open'
const ACCESS_TEXT: Record<AccessKind, string> = { open: 'Open', locked: 'Locked', override: 'Open by Coach override' }

export function EnrolledVersionView({ accountId, document }: { accountId: string; document: EnrolledVersion }) {
  const enrollmentId = document.enrollment.id
  const skills = document.application.skills
  const connections = document.editor.connections
  const [cards] = useState(() => document.editor.cards.map((card) => ({ id: card.id, title: card.title, position: card.position })))
  const [camera] = useState<CameraState | null>(() => (typeof window === 'undefined' ? null : loadCameraState(window.localStorage, accountId, enrollmentCameraContext(enrollmentId))))
  const [selectedSkill, setSelectedSkill] = useState<SelectedSkillInfo | null>(null)
  const [gpuStatus, setGpuStatus] = useState<GpuStatus>('initializing')
  const [view, setView] = useState<RecordsView>({ records: null, readAt: null, generation: 0, reading: true, error: null })
  const actionsRef = useRef<WebGpuEditorActions | null>(null)
  /** The Task whose Review the Coach opened from the queue; its panel takes focus once shown. */
  const [focusTaskId, setFocusTaskId] = useState<string | null>(null)
  const clearFocusTask = useCallback(() => setFocusTaskId(null), [])
  // Reads are numbered as issued; an answer older than the one shown is dropped.
  const reads = useRef({ issued: 0, shown: 0 })
  const latestRead = useRef<Promise<boolean>>(Promise.resolve(false))

  /**
   * Reads the records again. Resolves true once records read after this call started are
   * on show, false when the latest read failed and the records shown may be out of date.
   */
  const loadRecords = useCallback(() => {
    const read = async (): Promise<boolean> => {
      const ticket = ++reads.current.issued
      setView((current) => ({ ...current, reading: true }))
      let outcome: { records: EnrollmentLearningState } | { error: string }
      try {
        const result = await readEnrollmentLearningState(enrollmentId)
        outcome = result.ok ? { records: result.value.learningState } : { error: result.error }
      } catch {
        outcome = { error: 'the backend could not be reached' }
      }
      // A later read decides what is on show.
      if (ticket < reads.current.shown) return latestRead.current
      reads.current.shown = ticket
      const done = ticket === reads.current.issued
      setView((current) => 'records' in outcome
        ? { records: outcome.records, readAt: new Date(), generation: current.generation + 1, reading: !done, error: null }
        : { ...current, reading: !done, error: outcome.error })
      return done ? 'records' in outcome : latestRead.current
    }
    const promise = read()
    latestRead.current = promise
    return promise
  }, [enrollmentId])
  useEffect(() => { void loadRecords() }, [loadRecords])

  // Returning to the page reads the records again: the Coach may have changed them meanwhile.
  useEffect(() => {
    const revalidate = () => { if (window.document.visibilityState === 'visible') void loadRecords() }
    window.addEventListener('focus', revalidate)
    window.document.addEventListener('visibilitychange', revalidate)
    return () => {
      window.removeEventListener('focus', revalidate)
      window.document.removeEventListener('visibilitychange', revalidate)
    }
  }, [loadRecords])

  const handleActionsReady = useCallback((actions: WebGpuEditorActions) => { actionsRef.current = actions }, [])
  const handleCameraChanged = useCallback((next: CameraState) => {
    if (typeof window !== 'undefined') saveCameraState(window.localStorage, accountId, enrollmentCameraContext(enrollmentId), next)
  }, [accountId, enrollmentId])
  const handleSelectListSkill = useCallback((skill: SelectedSkillInfo | null) => {
    setSelectedSkill(skill)
    actionsRef.current?.selectCard(skill?.id ?? null)
  }, [])

  const shown = view.records
  const skillTitles = useMemo(() => new Map(skills.map((skill) => [skill.id, skill.title])), [skills])
  const taskTitles = useMemo(() => new Map(skills.flatMap((skill) => skill.tasks.map((task) => [task.id, task.title] as const))), [skills])
  const stateOf = (id: string) => shown?.skills.find((skill) => skill.skillId === id)
  const labelStatus = useMemo(() => shown
    ? Object.fromEntries(shown.skills.map((skill) => [skill.skillId, { locked: !skill.access, mastered: skill.mastery }]))
    : undefined, [shown])
  const selected = skills.find((skill) => skill.id === selectedSkill?.id)
  const status = shown?.enrollmentStatus ?? document.enrollment.status
  const coach = document.viewer === 'coach'
  const awaitingBySkill = useMemo(() => {
    const counts = new Map<string, number>()
    for (const revision of shown?.awaitingReview ?? []) {
      const skill = skills.find((s) => s.tasks.some((task) => task.id === revision.taskId))
      if (skill) counts.set(skill.id, (counts.get(skill.id) ?? 0) + 1)
    }
    return counts
  }, [shown, skills])
  const overrideNames = useMemo<OverrideNames>(() => ({ viewerAccountId: accountId, coach: document.coach, learner: document.learner, skillTitles }), [accountId, document.coach, document.learner, skillTitles])
  const openReview = useCallback((skill: PathSkill, taskId: string) => {
    handleSelectListSkill({ id: skill.id, title: skill.title })
    setFocusTaskId(taskId)
  }, [handleSelectListSkill])

  return (
    <div id="enrolled-version" data-enrollment-id={enrollmentId} data-version-id={document.version.id} data-gpu-status={gpuStatus} className="flex-1 min-h-0 flex flex-col">
      <div className="shrink-0 border-b border-slate-800/80 bg-slate-900/60 px-4 py-2 flex flex-wrap items-center gap-3">
        <h1 id="enrolled-path-title" className="text-sm font-semibold text-slate-100">{document.learningPath.title}</h1>
        <span id="enrolled-version-badge" data-version-number={document.version.versionNumber} className="text-xs px-2 py-1 rounded-lg border border-violet-800/60 text-violet-200 bg-slate-950/80">
          Version {document.version.versionNumber}
        </span>
        <span id="enrolled-workspace" className="text-xs text-slate-400">with {document.coachWorkspace.name}</span>
        {coach && <span id="enrolled-learner" className="text-xs text-slate-300">Learner: {document.learner.name || document.learner.email} ({document.learner.email})</span>}
        <span id="enrollment-status" data-status={status} className={`text-xs px-2 py-1 rounded-lg border ${status === 'active' ? 'text-emerald-300 border-emerald-800/60' : 'text-amber-200 border-amber-800/60'}`}>
          Enrollment {status}
        </span>
        <span id="enrollment-xp" data-xp={shown?.xp ?? ''} title="XP from approved Tasks in this Enrollment only" className="text-xs px-2 py-1 rounded-lg border border-slate-700 text-slate-200">
          {shown ? `${shown.xp} XP in this Enrollment` : 'XP…'}
        </span>
        <span id="enrollment-records" data-generation={view.generation} data-reading={view.reading} className="flex items-center gap-2 text-xs">
          {view.readAt && <span id="enrollment-records-read-at" className="text-slate-500">as of {view.readAt.toLocaleTimeString()}</span>}
          {view.error && (
            <span id="enrollment-records-error" role="alert" className="text-red-300">
              Could not {view.records ? 'refresh' : 'read'} your learning records ({view.error}){view.records ? '; the state shown may be out of date' : ''}.
            </span>
          )}
          <button id="enrollment-records-refresh" onClick={() => void loadRecords()} disabled={view.reading} className="text-slate-200 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 border border-slate-700 px-2 py-1 rounded-lg cursor-pointer">
            {view.reading ? 'Reading…' : view.error ? 'Try again' : 'Refresh'}
          </button>
        </span>
      </div>
      <p id="version-pinned-note" className="shrink-0 px-4 py-1.5 text-[11px] text-slate-400 border-b border-slate-800/80 bg-slate-950">
        {document.learningPath.goal && <>Goal: {document.learningPath.goal} · </>}
        Your Enrollment stays on Version {document.version.versionNumber} exactly as it was published; later Versions do not change its Skills, Tasks or rules.
        {status === 'inactive' && <span id="enrollment-inactive-note" className="text-amber-200"> This Enrollment is inactive: you can still read everything here, but only {coach ? 'you' : 'the Coach'} can reactivate it.</span>}
      </p>
      <EnrollmentParticipation
        enrollmentId={enrollmentId}
        actor={coach ? 'coach' : 'learner'}
        records={shown}
        versionNumber={document.version.versionNumber}
        names={overrideNames}
        onChanged={loadRecords}
      />
      <section className="w-full flex-1 min-h-0 flex flex-col md:flex-row overflow-y-auto md:overflow-hidden relative">
        <div className="w-full md:w-64 lg:w-72 shrink-0 md:h-full flex flex-col border-b md:border-b-0 md:border-r border-slate-800/80 min-h-0">
          {coach && <AwaitingReviewQueue awaiting={shown?.awaitingReview ?? null} inactive={status === 'inactive'} skills={skills} onOpen={openReview} />}
          <SkillPrerequisiteList
            skills={skills}
            connections={connections}
            selectedSkillId={selectedSkill?.id ?? null}
            onSelectSkill={handleSelectListSkill}
            renderStatus={(id) => <EnrolledSkillChips skill={stateOf(id)} skillId={id} awaiting={coach ? awaitingBySkill.get(id) ?? 0 : 0} />}
            className="flex-1 min-h-0"
          />
        </div>
        <WebGpuEditor
          readOnly
          onSelectSkill={setSelectedSkill}
          onActionsReady={handleActionsReady}
          initialCards={cards}
          initialConnections={connections}
          initialCamera={camera}
          onCameraChanged={handleCameraChanged}
          onGpuStatusChange={setGpuStatus}
          labelStatus={labelStatus}
        />
        <SkillDetailPanel
          selectedSkill={selectedSkill}
          allSkills={skills}
          connections={connections}
          tasks={selected?.tasks}
          outcome={selected?.outcome ?? ''}
          learning={selected && <EnrolledSkillLearning view={view} skillId={selected.id} skillTitles={skillTitles} taskTitles={taskTitles} coach={coach} enrollmentId={enrollmentId} names={overrideNames} onRecordsStale={loadRecords} />}
          renderTaskExtra={(taskId) => (
            <EnrolledTaskLearning
              key={taskId}
              accountId={accountId}
              viewer={document.viewer}
              enrollmentId={enrollmentId}
              taskId={taskId}
              records={shown}
              skillTitles={skillTitles}
              generation={view.generation}
              onRecordsStale={loadRecords}
              focusReview={focusTaskId === taskId}
              onReviewFocused={clearFocusTask}
            />
          )}
        />
      </section>
    </div>
  )
}

/** A Skill's Access and Mastery in the keyboard list, as two separate chips, and for the Coach the work awaiting Review. */
function EnrolledSkillChips({ skill, skillId, awaiting }: { skill: EnrollmentSkillState | undefined; skillId: string; awaiting: number }) {
  if (!skill) return null
  const kind = accessKind(skill)
  return (
    <span id={`skill-status-${skillId}`} data-access={kind} data-mastery={skill.mastery ? 'mastered' : 'not-mastered'} data-awaiting-review={awaiting} className="mt-1 flex flex-wrap gap-1 text-[9px] font-mono">
      <span className={`px-1 rounded border ${kind === 'locked' ? 'text-red-300 border-red-900/70' : 'text-emerald-300 border-emerald-900/70'}`}>{ACCESS_TEXT[kind]}</span>
      <span className={`px-1 rounded border ${skill.mastery ? 'text-violet-300 border-violet-900/70' : 'text-slate-400 border-slate-700'}`}>{skill.mastery ? 'Mastered' : 'Not mastered'}</span>
      {awaiting > 0 && <span className="px-1 rounded border text-sky-300 border-sky-900/70">{awaiting} awaiting Review</span>}
    </span>
  )
}

/**
 * The Coach's queue of revisions awaiting a decision in this Enrollment, oldest first,
 * as the backend last listed them. Each entry opens its Task in the sidebar with the
 * Review focused, so no canvas is needed to reach it. Work stays listed after the Skill
 * locks or the Enrollment is deactivated: it was sent with valid Access (ADR 0007).
 */
function AwaitingReviewQueue({ awaiting, inactive, skills, onOpen }: { awaiting: AwaitingRevision[] | null; inactive: boolean; skills: PathSkill[]; onOpen: (skill: PathSkill, taskId: string) => void }) {
  return (
    <section id="awaiting-review" data-count={awaiting?.length ?? ''} aria-labelledby="awaiting-review-heading" className="shrink-0 border-b border-slate-800/80 p-3 space-y-2">
      <h2 id="awaiting-review-heading" className="text-[10px] font-semibold uppercase tracking-wider text-sky-300">Awaiting your Review</h2>
      {awaiting === null && <p className="text-[11px] text-slate-500">Loading…</p>}
      {awaiting?.length === 0 && <p id="awaiting-review-empty" className="text-[11px] text-slate-500">Nothing sent is waiting for a decision.</p>}
      {inactive && awaiting && awaiting.length > 0 && (
        <p id="awaiting-review-inactive" className="text-[10px] text-amber-200">
          This Enrollment is inactive. This work was sent while it was active, so you can still decide it: an Approval adds XP and Mastery as usual and does not reactivate the Enrollment.
        </p>
      )}
      {awaiting && awaiting.length > 0 && (
        <ul className="space-y-1">
          {awaiting.map((revision) => {
            const skill = skills.find((s) => s.tasks.some((task) => task.id === revision.taskId))
            const task = skill?.tasks.find((t) => t.id === revision.taskId)
            if (!skill || !task) return null
            return (
              <li key={revision.revisionId}>
                <button
                  id={`awaiting-review-${revision.taskId}`}
                  data-revision-number={revision.revisionNumber}
                  onClick={() => onOpen(skill, revision.taskId)}
                  className="w-full text-left text-[11px] rounded-lg border border-sky-900/60 bg-slate-900/60 hover:bg-slate-800 px-2 py-1.5 text-slate-200 cursor-pointer focus:outline-none focus:ring-1 focus:ring-sky-500"
                >
                  <span className="block font-medium">{task.title}</span>
                  <span className="block text-[10px] text-slate-400">{skill.title} · Revision {revision.revisionNumber} · sent {new Date(revision.sentAt).toLocaleString()}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

/**
 * The selected Skill's Access (with its lock reasons, its Access Override and every
 * Override Record) and Mastery, and the XP its Tasks contribute. The Coach grants or
 * revokes the override here.
 */
function EnrolledSkillLearning({ view, skillId, skillTitles, taskTitles, coach, enrollmentId, names, onRecordsStale }: {
  view: RecordsView
  skillId: string
  skillTitles: Map<string, string>
  taskTitles: Map<string, string>
  coach: boolean
  enrollmentId: string
  names: OverrideNames
  /** Reads the records again; true once fresh records are on show. */
  onRecordsStale: () => Promise<boolean>
}) {
  if (!view.records) {
    return <div id="skill-learning" data-tracked="false" className="text-[11px] text-slate-500 italic bg-slate-800/30 rounded-xl p-3 border border-slate-700/30">{view.error ? 'Learning records are unavailable.' : 'Loading learning records…'}</div>
  }
  const state = view.records
  const skill = state.skills.find((s) => s.skillId === skillId)
  if (!skill) return null
  const kind = accessKind(skill)
  const reasons = enrollmentLockReasons(skill, state, skillTitles)
  const skillXp = state.tasks.filter((task) => task.skillId === skillId).reduce((total, task) => total + task.xpContribution, 0)
  const masteryEvents = state.masteryHistory.filter((event) => event.skillId === skillId)
  const overrideRecords = state.overrideHistory.filter((record) => record.skillId === skillId)
  const waived = skill.accessOverride ? ordinaryRequirements(skill, state, skillTitles) : []
  return (
    <div id="skill-learning" data-tracked="true" className="space-y-3">
      <section id="skill-access" data-access={kind} aria-labelledby="skill-access-heading" className={`rounded-xl p-3 border ${kind === 'locked' ? 'bg-red-950/30 border-red-900/60' : 'bg-emerald-950/20 border-emerald-900/50'}`}>
        <div className="flex items-center justify-between gap-2">
          <h4 id="skill-access-heading" className="text-xs font-semibold uppercase tracking-wider text-slate-400">Access</h4>
          <span id="skill-access-state" className={`text-xs font-semibold ${kind === 'locked' ? 'text-red-300' : 'text-emerald-300'}`}>{ACCESS_TEXT[kind]}</span>
        </div>
        {kind === 'locked' && reasons.length > 0 && (
          <ul id="lock-reasons" aria-label="Why this Skill is locked" className="mt-2 space-y-1 text-[11px] text-slate-300 list-disc pl-4">
            {reasons.map((reason) => <li key={reason}>{reason}</li>)}
          </ul>
        )}
        {skill.accessOverride && (
          <div id="skill-override" data-override-id={skill.accessOverride.id} className="mt-2 space-y-1 text-[10px]">
            <p className="text-sky-200">
              {coach ? 'Your Access Override waives this Skill\'s Prerequisites and XP Threshold for this learner, in this Enrollment only' : 'Your Coach waived this Skill\'s Prerequisites and XP Threshold for you, in this Enrollment only'}: {skill.accessOverride.reason}
            </p>
            {waived.length > 0 && (
              <ul id="override-waived" aria-label="Requirements the Access Override waives" className="text-slate-400 list-disc pl-4 space-y-0.5">
                {waived.map((line) => <li key={line}>Waived: {line}</li>)}
              </ul>
            )}
            <p className="text-slate-500">It changes no XP or Mastery.</p>
            {state.enrollmentStatus === 'inactive' && (
              <p id="skill-override-inactive" className="text-amber-200">
                It does not reactivate this Enrollment: while the Enrollment is inactive, no Task can be started and no work sent here{coach ? ', override or not' : ''}. Only the Coach's reactivation resumes it.
              </p>
            )}
          </div>
        )}
        <p className="mt-1 text-[10px] text-slate-500">Access lets you start Tasks and send work. Reaching an XP Threshold spends no XP.</p>
        {coach && <AccessOverrideControl key={skillId} enrollmentId={enrollmentId} skill={skill} records={state} names={names} onChanged={onRecordsStale} />}
        {overrideRecords.length > 0 && (
          <ol id="skill-override-history" data-records={overrideRecords.length} aria-label="Override Records of this Skill" className="mt-2 text-[10px] text-slate-400 space-y-1 border-t border-slate-700/50 pt-2">
            {overrideRecords.map((record) => {
              const text = overrideRecordText(record, names)
              return (
                <li key={record.id} id={`override-record-${record.id}`} data-action={record.action} data-sequence={record.sequence}>
                  <span className="text-slate-300">{text.action}</span> {text.actor} · {text.target} · {new Date(record.occurredAt).toLocaleString()} · {text.reason}
                </li>
              )
            })}
          </ol>
        )}
      </section>
      <section id="skill-mastery" data-mastery={skill.mastery ? 'mastered' : 'not-mastered'} aria-labelledby="skill-mastery-heading" className="rounded-xl p-3 border bg-slate-800/40 border-slate-700/40">
        <div className="flex items-center justify-between gap-2">
          <h4 id="skill-mastery-heading" className="text-xs font-semibold uppercase tracking-wider text-slate-400">Mastery</h4>
          <span id="skill-mastery-state" className={`text-xs font-semibold ${skill.mastery ? 'text-violet-300' : 'text-slate-400'}`}>{skill.mastery ? 'Mastered' : 'Not mastered yet'}</span>
        </div>
        <p className="mt-1 text-[10px] text-slate-500">Awarded when every Required Task of this Skill has an Approval from your Coach, and revoked if one of them loses its last valid Approval.</p>
        {skill.mastery && !skill.access && (
          <p id="skill-mastery-kept" className="mt-1 text-[10px] text-violet-200">
            This Skill is locked, but its Mastery stays: it rests on the Approvals of its own Required Tasks, which still count. Access and Mastery are separate.
          </p>
        )}
        {masteryEvents.length > 0 && (
          <ul id="skill-mastery-history" data-events={masteryEvents.length} aria-label="Mastery history of this Skill" className="mt-2 text-[10px] text-slate-400 space-y-0.5">
            {masteryEvents.map((event) => (
              <li key={event.id} data-action={event.action}>{masteryEventText(event, taskTitles.get(event.taskId) ?? 'a Task')} · {new Date(event.occurredAt).toLocaleString()}</li>
            ))}
          </ul>
        )}
      </section>
      <p id="skill-xp" data-xp={skillXp} className="text-[11px] text-slate-400">This Skill's Tasks contribute {skillXp} of your {state.xp} Enrollment XP.</p>
    </div>
  )
}

const REVISION_STATUS: Record<SubmissionRevisionView['status'], string> = {
  pending: 'Awaiting Review',
  superseded: 'Superseded by a later revision',
  approval: 'Approved',
  approval_revoked: 'Approval revoked',
  changes_requested: 'Changes requested',
}

type History =
  | { state: 'loading' }
  | { state: 'none' }
  | { state: 'ready'; revisions: SubmissionRevisionView[] }
  | { state: 'failed'; error: string }

/**
 * A Task's reward and contribution in this Enrollment, the learner's private draft, and
 * the work already sent for it, which stays readable when locked. The sent history is
 * read again with each confirmed read of the records (`generation`) and after each
 * confirmed send; the history on show stays until the new one arrives.
 */
function EnrolledTaskLearning({ accountId, viewer, enrollmentId, taskId, records, skillTitles, generation, onRecordsStale, focusReview, onReviewFocused }: {
  accountId: string
  viewer: EnrolledVersion['viewer']
  enrollmentId: string
  taskId: string
  records: EnrollmentLearningState | null
  skillTitles: Map<string, string>
  generation: number
  /** Reads the records again; true once fresh records are on show. */
  onRecordsStale: () => Promise<boolean>
  focusReview: boolean
  onReviewFocused: () => void
}) {
  const [history, setHistory] = useState<History>({ state: 'loading' })
  const latest = useRef(0)
  const latestLoad = useRef<Promise<boolean>>(Promise.resolve(false))
  /** Reads the history again; true once a history read after this call started is on show. */
  const load = useCallback(() => {
    const read = async (): Promise<boolean> => {
      const ticket = ++latest.current
      setHistory((current) => (current.state === 'failed' ? { state: 'loading' } : current))
      let next: History
      try {
        const result = await readTaskSubmission(enrollmentId, taskId)
        next = result.ok ? { state: 'ready', revisions: result.value.submission.revisions }
          : result.error === 'submission_not_found' ? { state: 'none' } : { state: 'failed', error: result.error }
      } catch {
        next = { state: 'failed', error: 'the backend could not be reached' }
      }
      // Only the latest read is shown; an earlier one answering late is dropped.
      if (ticket !== latest.current) return latestLoad.current
      setHistory(next)
      return next.state !== 'failed'
    }
    const promise = read()
    latestLoad.current = promise
    return promise
  }, [enrollmentId, taskId])
  useEffect(() => { void load() }, [load, generation])

  const task = records?.tasks.find((t) => t.taskId === taskId)
  const started = records?.taskStarts.some((start) => start.taskId === taskId) ?? false
  const xpEvents = records?.xpHistory.filter((event) => event.taskId === taskId) ?? []
  const revisions = history.state === 'ready' ? history.revisions : history.state === 'none' ? [] : null
  /** The backend answered a Review or revocation: read the history and records again; true once both are on show. */
  const reread = useCallback(async () => (await Promise.all([load(), onRecordsStale()])).every(Boolean), [load, onRecordsStale])
  const revocationTask = task ? { xpReward: task.xpReward, required: task.required, skillTitle: skillTitles.get(task.skillId) ?? 'this Skill' } : null
  return (
    <div id={`task-learning-${taskId}`} data-approved={task?.approved ?? ''} data-xp-contribution={task?.xpContribution ?? ''} data-started={started} className="space-y-2 text-[11px]">
      {task && (
        <p className="text-slate-400">
          Reward {task.xpReward} XP · <span className={task.approved ? 'text-emerald-300' : 'text-slate-400'}>{task.approved ? `approved, contributes ${task.xpContribution} XP` : 'contributes 0 XP until approved'}</span>
          {started && ' · started'}
        </p>
      )}
      {xpEvents.length > 0 && (
        <ul id={`task-xp-history-${taskId}`} data-events={xpEvents.length} aria-label="XP history of this Task" className="text-[10px] text-slate-500 space-y-0.5">
          {xpEvents.map((event) => (
            <li key={event.id} data-kind={event.kind} data-amount={event.amount}>{xpEventText(event)} · {new Date(event.occurredAt).toLocaleString()}</li>
          ))}
        </ul>
      )}
      {viewer === 'learner' && (
        <TaskWork
          accountId={accountId}
          enrollmentId={enrollmentId}
          taskId={taskId}
          records={records}
          sentRevisions={revisions?.length ?? null}
          onSent={() => { void load(); void onRecordsStale() }}
          onRefused={() => void onRecordsStale()}
        />
      )}
      <div id={`task-history-${taskId}`} data-state={history.state} data-revisions={history.state === 'ready' ? history.revisions.length : 0} className="border-t border-slate-700/50 pt-2">
        <h6 className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{viewer === 'learner' ? 'Your submitted work' : 'Submitted work'}</h6>
        <p className="text-[10px] text-slate-500 mb-1">One Submission for this Task; each sent revision is kept unchanged.</p>
        {history.state === 'loading' && <p className="text-slate-500">Loading…</p>}
        {history.state === 'none' && <p className="text-slate-500">No work sent for this Task yet.</p>}
        {history.state === 'failed' && (
          <p role="alert" className="text-red-300">
            Could not read the submitted work ({history.error}).{' '}
            <button id={`task-history-retry-${taskId}`} onClick={() => void load()} className="underline cursor-pointer">Try again</button>
          </p>
        )}
        {history.state === 'ready' && (
          <ol className="space-y-1.5">
            {history.revisions.map((revision) => (
              <li key={revision.id} id={`revision-${revision.id}`} data-status={revision.status} data-revision-number={revision.revisionNumber} className="rounded-lg bg-slate-950/60 border border-slate-800 p-2 space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-300">Revision {revision.revisionNumber}</span>
                  <span className="text-slate-400">{REVISION_STATUS[revision.status]}</span>
                </div>
                <p className="text-[10px] text-slate-500">Sent {new Date(revision.sentAt).toLocaleString()}</p>
                <p className="revision-note text-[10px] text-slate-400">{viewer === 'learner' ? revisionNote(revision, history.revisions) : coachRevisionNote(revision, history.revisions)}</p>
                {revision.text && <p className="text-slate-300 whitespace-pre-wrap">{revision.text}</p>}
                {revision.urls.map((url) => <a key={url} href={url} target="_blank" rel="noreferrer noopener" className="block text-sky-300 hover:text-sky-200 truncate">{url}</a>)}
                {revision.review && <p className="text-[10px] text-slate-500">{DECISION_TEXT[revision.review.decision]} decided {new Date(revision.review.decidedAt).toLocaleString()}</p>}
                {revision.review?.feedback && <p className="revision-feedback text-slate-300">Feedback: {revision.review.feedback}</p>}
                {revision.review?.revokedAt && (
                  <RevocationRecord revision={revision} taskId={taskId} records={records} skillTitles={skillTitles} />
                )}
                {viewer === 'coach' && (
                  <ApprovalRevocation enrollmentId={enrollmentId} taskId={taskId} revision={revision} revisions={history.revisions} task={revocationTask} onChanged={reread} />
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
      {viewer === 'coach' && (
        <TaskReview
          enrollmentId={enrollmentId}
          taskId={taskId}
          revisions={revisions}
          focusRequested={focusReview}
          onFocused={onReviewFocused}
          onChanged={reread}
        />
      )}
    </div>
  )
}

/**
 * A revoked Approval as both the learner and the Coach read it: when and why, and what
 * it changed as the backend read it with this history (kept by other Approvals, or corrected).
 */
function RevocationRecord({ revision, taskId, records, skillTitles }: {
  revision: SubmissionRevisionView
  taskId: string
  records: EnrollmentLearningState | null
  skillTitles: Map<string, string>
}) {
  const review = revision.review!
  const effect = records && revocationEffect(revision, taskId, records, skillTitles)
  return (
    <div id={`revision-revocation-${revision.id}`} className="rounded border border-amber-900/50 bg-amber-950/10 p-1.5 space-y-0.5">
      <p className="text-amber-200">Approval revoked {new Date(review.revokedAt!).toLocaleString()}: {review.revocationReason}</p>
      {effect && (
        <ul className="revocation-effect text-[10px] text-slate-300 space-y-0.5">
          {effect.map((line) => <li key={line}>{line}</li>)}
        </ul>
      )}
    </div>
  )
}
