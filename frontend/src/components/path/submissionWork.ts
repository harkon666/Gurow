/**
 * A learner's private work on one Task of an Enrollment (ADR 0002, US42–US50, US78,
 * US79): the editable Submission Draft, its local recovery copy, and what may be sent.
 * The draft is visible only to its learner; a sent revision is immutable and counts
 * as sent only once the backend confirms it. Local recovery keeps unsaved edits in
 * this browser under the Account, Enrollment and Task they belong to, so another
 * Account (a peer, the Coach) signing in here never reads them.
 */
import type { EnrollmentLearningState, SubmissionContents, SubmissionRevisionView } from '../../lib/api'

/** Limits the backend applies to drafts and revisions; checked here to explain them before a request. */
export const MAX_TEXT_LENGTH = 50_000
export const MAX_URLS = 20
export const MAX_URL_LENGTH = 2_048

/** The local recovery key: one per Account, Enrollment and Task. */
export const draftRecoveryKey = (accountId: string, enrollmentId: string, taskId: string) =>
  `gurow:submission-draft:${accountId}:${enrollmentId}:${taskId}`

/** Unsaved edits as kept in this browser; `urls` keeps every link field as typed, empty ones included. */
export interface RecoveredDraft extends SubmissionContents { editedAt: string }

/** The contents a draft or revision would hold: link fields left empty are not links. */
export function contentsOf(edits: SubmissionContents): SubmissionContents {
  return { text: edits.text, urls: edits.urls.map((url) => url.trim()).filter((url) => url !== '') }
}

export const sameContents = (a: SubmissionContents | null, b: SubmissionContents | null) => {
  const left = contentsOf(a ?? { text: '', urls: [] }), right = contentsOf(b ?? { text: '', urls: [] })
  return left.text === right.text && left.urls.length === right.urls.length && left.urls.every((url, i) => url === right.urls[i])
}

/** Reads the recovery copy; anything unreadable is dropped rather than shown. */
export function loadRecoveredDraft(storage: Storage, key: string): RecoveredDraft | null {
  try {
    const raw = storage.getItem(key)
    if (raw === null) return null
    const value = JSON.parse(raw) as Partial<RecoveredDraft>
    if (typeof value.text === 'string' && Array.isArray(value.urls) && value.urls.every((url) => typeof url === 'string') && typeof value.editedAt === 'string') {
      return { text: value.text, urls: value.urls, editedAt: value.editedAt }
    }
    storage.removeItem(key)
  } catch {
    // Unavailable or corrupt storage: there is nothing to recover.
  }
  return null
}

/**
 * Keeps edits that differ from the saved draft in this browser, and forgets them once
 * the saved draft holds the same contents. Returns whether a recovery copy is kept.
 */
export function rememberEdits(storage: Storage, key: string, edits: SubmissionContents, saved: SubmissionContents | null, now = new Date()): boolean {
  try {
    if (sameContents(edits, saved)) {
      storage.removeItem(key)
      return false
    }
    storage.setItem(key, JSON.stringify({ text: edits.text, urls: edits.urls, editedAt: now.toISOString() } satisfies RecoveredDraft))
    return true
  } catch {
    return false
  }
}

/** Why the contents cannot be saved or sent as they are, in the learner's terms; null when they can. */
export function contentsProblem(edits: SubmissionContents): string | null {
  const { text, urls } = contentsOf(edits)
  if (text.length > MAX_TEXT_LENGTH) return `The text is longer than ${MAX_TEXT_LENGTH.toLocaleString('en')} characters.`
  if (urls.length > MAX_URLS) return `At most ${MAX_URLS} links can be attached.`
  for (const url of urls) {
    if (url.length > MAX_URL_LENGTH || !URL.canParse(url) || !['http:', 'https:'].includes(new URL(url).protocol)) {
      return `“${url.length > 60 ? `${url.slice(0, 60)}…` : url}” is not a full http(s) link.`
    }
  }
  return null
}

export const isEmpty = (edits: SubmissionContents) => {
  const { text, urls } = contentsOf(edits)
  return text.trim() === '' && urls.length === 0
}

/**
 * Why work for this Task cannot be sent now, from the last confirmed records; null
 * when the Enrollment is active and the Task's Skill is accessible. The backend checks
 * again when sending, so records that are out of date cannot send anything.
 */
export function sendBlockedReason(records: EnrollmentLearningState | null, taskId: string): string | null {
  if (!records) return 'Your learning records are not loaded yet, so Access cannot be checked.'
  if (records.enrollmentStatus !== 'active') return 'This Enrollment is inactive: you cannot send work until your Coach reactivates it.'
  const task = records.tasks.find((t) => t.taskId === taskId)
  const skill = task && records.skills.find((s) => s.skillId === task.skillId)
  if (!skill) return 'This Task is not part of your Enrollment\'s Version.'
  if (!skill.access) return 'This Skill is locked: sending work needs Access (see why above). Your draft stays private and editable.'
  return null
}

/** What a refused save or send means for the learner's work. */
export function refusalMessage(error: string): string {
  switch (error) {
    case 'skill_locked': return 'this Skill is locked now, and sending work needs Access'
    case 'enrollment_inactive': return 'this Enrollment is inactive'
    case 'empty_submission': return 'there is nothing to send: add text or a link'
    case 'invalid_contents': return 'the text or a link is not valid'
    case 'enrollment_not_found':
    case 'task_not_found': return 'this Enrollment is not available to the signed-in Account'
    case 'unreachable': return 'the backend could not be reached'
    default: return error
  }
}

/** How one sent revision stands, said so that no revision appears to inherit another's decision. */
export function revisionNote(revision: SubmissionRevisionView, revisions: SubmissionRevisionView[]): string {
  const later = revisions.find((r) => r.revisionNumber > revision.revisionNumber)
  const earlierApprovals = revisions.filter((r) => r.status === 'approval' && r.revisionNumber < revision.revisionNumber).map((r) => r.revisionNumber)
  switch (revision.status) {
    case 'approval': return 'Approved: this revision counts for the Task.'
    case 'approval_revoked': return 'Its Approval was revoked and no longer counts.'
    case 'changes_requested': return earlierApprovals.length
      ? `Your Coach asked for changes to this revision; the Approval of Revision ${earlierApprovals.join(', ')} still counts.`
      : 'Your Coach asked for changes; send a correction as a new revision.'
    case 'superseded': return `Replaced by Revision ${later?.revisionNumber ?? 'a later one'} before it was reviewed; it can no longer be reviewed.`
    case 'pending': {
      const approved = revisions.filter((r) => r.status === 'approval' && r.revisionNumber < revision.revisionNumber).map((r) => r.revisionNumber)
      return approved.length
        ? `Needs its own Review: it does not inherit the Approval of Revision ${approved.join(', ')}, which still counts.`
        : 'Waiting for your Coach\'s Review.'
    }
  }
}

/**
 * Whether a failed send was refused by the backend, which then wrote nothing. Any other
 * failure (no answer, a gateway error) leaves the outcome unknown: the revision may have
 * been committed before its answer was lost.
 */
export const isRefusal = (status: number) => status >= 400 && status < 500

/**
 * The revision a send whose answer was lost created, if the history read afterwards
 * holds it: the same contents, sent no earlier than the draft the backend saved just
 * before that send (both times are the backend's).
 */
export function findSentRevision(revisions: SubmissionRevisionView[], sent: SubmissionContents, notBefore: string): SubmissionRevisionView | null {
  const after = Date.parse(notBefore)
  return [...revisions].reverse().find((r) => Date.parse(r.sentAt) >= after && sameContents(r, sent)) ?? null
}
