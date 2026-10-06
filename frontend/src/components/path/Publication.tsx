import { Link } from '@tanstack/react-router'
import { useState, type ReactNode } from 'react'
import { EnrollmentAdmission } from './Admission'
import { VersionEnrollments } from './VersionEnrollments'
import { prepareCoachDraft, publishCoachDraft, type BlockedSkill, type CoachPathDocument } from '../../lib/api'

/**
 * Publishing a Coach's Draft (ADR 0005, 0008). Publication freezes the Draft as a
 * Version once its required route can be completed; a blocked route is explained
 * by Skill and unmet requirement. Published content is only read here: any change,
 * a typo correction included, starts a new Draft.
 */

type Refusal = { revision: number; detail: string; blockedSkills: BlockedSkill[] }

/**
 * Publishes the open Draft as saved at `save.revision`. Only a saved Draft can be
 * published, so what is published is what the Coach sees; a refusal stays shown
 * until the Draft changes.
 */
export function PublishControl({ pathId, versionNumber, save, onPublished }: {
  pathId: string
  versionNumber: number
  save: { saved: boolean; revision: number }
  onPublished: () => void
}) {
  const [pending, setPending] = useState(false)
  const [refusal, setRefusal] = useState<Refusal | null>(null)
  const shown = refusal && refusal.revision === save.revision ? refusal : null

  const publish = async () => {
    setPending(true)
    const result = await publishCoachDraft(pathId, save.revision).catch(() => null)
    setPending(false)
    if (result?.ok) return onPublished()
    const body = result?.body
    const detail = typeof body?.detail === 'string' ? body.detail : result ? result.error : 'the backend could not be reached'
    const blockedSkills = Array.isArray(body?.blockedSkills) ? body.blockedSkills as BlockedSkill[] : []
    setRefusal({ revision: save.revision, detail: result?.error === 'stale_revision' ? 'This Draft was changed elsewhere; reload it before publishing.' : detail, blockedSkills })
  }

  return (
    <div className="relative">
      <button
        id="publish-version-btn"
        onClick={() => void publish()}
        disabled={!save.saved || pending}
        title={save.saved ? `Check the required route and publish Version ${versionNumber}` : 'Wait until the Draft is saved'}
        className="text-xs font-medium bg-sky-700 hover:bg-sky-600 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg px-2.5 py-1 cursor-pointer"
      >
        {pending ? 'Publishing…' : `Publish Version ${versionNumber}`}
      </button>
      {shown && (
        <div id="publication-problems" role="alert" className="absolute right-0 top-full mt-2 z-30 w-[26rem] max-w-[90vw] bg-slate-900 border border-red-800/70 rounded-xl p-3 shadow-xl flex flex-col gap-2 text-xs">
          <div className="flex items-start justify-between gap-2">
            <h2 className="font-semibold text-red-200">Version {versionNumber} was not published</h2>
            <button id="dismiss-publication-problems" onClick={() => setRefusal(null)} aria-label="Dismiss" className="text-slate-400 hover:text-slate-200 cursor-pointer">✕</button>
          </div>
          {shown.blockedSkills.length === 0 ? (
            <p id="publication-problem-detail" className="text-slate-300">{shown.detail}</p>
          ) : (
            <>
              <p className="text-slate-400">Learners could not complete these required Skills using Required Tasks on required Skills alone:</p>
              <ul className="flex flex-col gap-1.5">
                {shown.blockedSkills.map((skill) => (
                  <li key={skill.skillId} data-blocked-skill-id={skill.skillId} className="border border-slate-800 rounded-lg px-2 py-1.5">
                    <span className="font-medium text-slate-100">{skill.title}</span>
                    <ul className="list-disc ml-4 text-slate-300">
                      {skill.unmet.map((unmet, index) => <li key={index} data-unmet={unmet.kind}>{unmet.message}</li>)}
                    </ul>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** Starts the next Version as a Draft copied from the latest published one. */
export function PrepareDraftControl({ pathId, revision, nextVersion, onPrepared }: { pathId: string; revision: number; nextVersion: number; onPrepared: () => void }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const prepare = async () => {
    setPending(true)
    const result = await prepareCoachDraft(pathId, revision).catch(() => null)
    setPending(false)
    if (result?.ok) return onPrepared()
    setError(result?.error === 'stale_revision' || result?.error === 'draft_already_open' ? 'This Path was changed elsewhere; reload it.' : result?.error ?? 'the backend could not be reached')
  }
  return (
    <div className="flex items-center gap-2 text-xs">
      <button
        id="prepare-draft-btn"
        onClick={() => void prepare()}
        disabled={pending}
        className="font-medium bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white rounded-lg px-2.5 py-1 cursor-pointer"
      >
        {pending ? 'Preparing…' : `Prepare Version ${nextVersion} as a Draft`}
      </button>
      {error && <span id="prepare-draft-error" role="alert" className="text-red-300">{error}</span>}
    </div>
  )
}

/** The Path's published Versions, oldest first, each readable on its own page. */
export function VersionHistory({ versions, currentVersionId }: { versions: CoachPathDocument['versions']; currentVersionId?: string }) {
  if (versions.length === 0) return <span id="version-history" className="text-slate-500">Not published yet</span>
  return (
    <span id="version-history" className="flex items-center gap-1.5 text-slate-400">
      Published:
      {versions.map((version) => (
        <Link
          key={version.id}
          id={`version-link-${version.versionNumber}`}
          to="/coach/versions/$versionId"
          params={{ versionId: version.id }}
          aria-current={version.id === currentVersionId ? 'page' : undefined}
          className={`px-1.5 rounded border ${version.id === currentVersionId ? 'text-slate-100 border-slate-600' : 'text-sky-300 border-transparent hover:text-sky-200'}`}
        >
          Version {version.versionNumber}
        </Link>
      ))}
    </span>
  )
}

/**
 * A published Version's learning content and rules, read-only: its own title and goal, Skills with outcomes,
 * Required or Optional designation, XP Thresholds and Prerequisites, and their Tasks
 * with Required or Enrichment designation and rewards. Below it, outside
 * the read-only content, the Coach invites learners and controls admission.
 */
export function PublishedVersionView({ document, actions }: { document: CoachPathDocument; actions?: ReactNode }) {
  const version = document.version!
  const titles = new Map(document.application.skills.map((skill) => [skill.id, skill.title]))
  const prerequisites = (id: string) => document.editor.connections.filter((edge) => edge.to_id === id).map((edge) => titles.get(edge.from_id) ?? edge.from_id)
  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-6 flex flex-col gap-4 max-w-4xl">
      <section id="published-version" data-version-id={version.id} data-version-number={version.versionNumber} className="flex flex-col gap-4">
        <header className="flex flex-wrap items-center gap-3">
          <h1 id="published-path-title" className="text-base font-semibold text-slate-100">{document.learningPath.title}</h1>
          <span id="published-version-badge" className="text-xs px-2 py-1 rounded-lg border border-sky-800/60 text-sky-200 bg-slate-950/80">
            Version {version.versionNumber} · published {version.publishedAt ? new Date(version.publishedAt).toLocaleString() : ''}
          </span>
          {actions}
        </header>
        {document.learningPath.goal && <p id="published-path-goal" className="text-xs text-slate-400">Goal: {document.learningPath.goal}</p>}
        <p id="published-version-immutable" className="text-xs text-slate-400">
          A published Version's learning content and rules cannot be edited, not even to correct a typo. Learners enrolled in it keep it as published; changes are prepared in a new Draft and published as a new Version.
        </p>
        <ol id="published-skills" className="flex flex-col gap-3">
          {document.application.skills.map((skill) => (
            <li key={skill.id} id={`published-skill-${skill.id}`} data-optional={skill.optional === true} className="border border-slate-800 rounded-xl p-3 bg-slate-900/50 flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <h2 data-field="title" className="text-sm font-semibold text-slate-100">{skill.title}</h2>
                <span className={`text-[10px] px-1.5 rounded border ${skill.optional ? 'text-sky-300 border-sky-900/70' : 'text-slate-300 border-slate-700'}`}>{skill.optional ? 'Optional' : 'Required'}</span>
                {(skill.xpThreshold ?? 0) > 0 && <span data-field="threshold" className="text-[10px] px-1.5 rounded border text-amber-300 border-amber-900/70">needs {skill.xpThreshold} XP</span>}
              </div>
              <p data-field="outcome" className="text-xs text-slate-300">{skill.outcome}</p>
              {prerequisites(skill.id).length > 0 && <p data-field="prerequisites" className="text-xs text-slate-400">Requires Mastery of: {prerequisites(skill.id).join(', ')}</p>}
              {skill.tasks.length === 0 ? <p className="text-xs text-slate-500">No Tasks</p> : (
                <ul className="flex flex-col gap-1">
                  {skill.tasks.map((task) => (
                    <li key={task.id} id={`published-task-${task.id}`} data-required={task.required === true} className="text-xs text-slate-300 border-l-2 border-slate-700 pl-2">
                      <span data-field="title" className="text-slate-100">{task.title}</span>
                      <span className="text-slate-500"> · {task.required ? 'Required' : 'Enrichment'} · {task.xpReward ?? 0} XP</span>
                      {task.description && <p className="text-slate-400">{task.description}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      </section>
      <EnrollmentAdmission key={version.id} versionId={version.id} versionNumber={version.versionNumber} />
      <VersionEnrollments key={`enrollments:${version.id}`} versionId={version.id} />
    </div>
  )
}
