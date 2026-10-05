import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { deliverInvitation, inviteToVersion, readAdmission, setEnrollmentClosure, type CoachInvitation, type DeliveryOutcome } from '../../lib/api'

/**
 * Admission to one published Version for its Coach (CONTEXT.md: Enrollment Invitation,
 * Enrollment Closure): invite one email at a time, see whether each email was
 * delivered and accepted, send one again, and close or reopen the Version to new
 * Enrollments. Every state shown is the backend's; Invitations have no expiry.
 */
export function EnrollmentAdmission({ versionId, versionNumber }: { versionId: string; versionNumber: number }) {
  const [admission, setAdmission] = useState<{ enrollmentClosed: boolean; invitations: CoachInvitation[] } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ kind: 'sent' | 'undelivered' | 'error'; text: string } | null>(null)
  // Counts the backend answers shown, so the same message twice still reads as a new answer.
  const [answers, setAnswers] = useState(0)
  useEffect(() => { if (notice) setAnswers((n) => n + 1) }, [notice])

  const load = useCallback(async () => {
    const result = await readAdmission(versionId).catch(() => null)
    if (result?.ok) {
      setAdmission(result.value)
      setLoadError(null)
    } else setLoadError(result?.error ?? 'the backend could not be reached')
  }, [versionId])
  useEffect(() => { void load() }, [load])

  const report = (outcome: DeliveryOutcome) => setNotice(outcome.delivered
    ? { kind: 'sent', text: `Invitation emailed to ${outcome.invitation.email}.` }
    : outcome.invitation.delivery.status === 'logged'
      ? { kind: 'undelivered', text: `The Invitation to ${outcome.invitation.email} is saved, but no email was sent: this server has no email provider configured, so the link was only written to its log.` }
      : { kind: 'undelivered', text: `The Invitation to ${outcome.invitation.email} is saved, but its email was not delivered (${outcome.deliveryError ?? 'unknown error'}). Send it again below.` })

  const invite = async (event: FormEvent) => {
    event.preventDefault()
    setPending('invite')
    setNotice(null)
    const result = await inviteToVersion(versionId, email).catch(() => null)
    setPending(null)
    if (result?.ok) {
      report(result.value)
      setEmail('')
    } else setNotice({ kind: 'error', text: result?.error === 'invalid_invitation' ? 'Enter one email address.' : `Could not invite (${result?.error ?? 'the backend could not be reached'}).` })
    await load()
  }

  const resend = async (invitationId: string) => {
    setPending(invitationId)
    setNotice(null)
    const result = await deliverInvitation(invitationId).catch(() => null)
    setPending(null)
    // A failed or merely logged delivery answers 502/503 with the Invitation it kept.
    if (result?.ok) report(result.value)
    else if (result?.body && 'invitation' in result.body) report(result.body as unknown as DeliveryOutcome)
    else setNotice({ kind: 'error', text: `Could not send the Invitation (${result?.error ?? 'the backend could not be reached'}).` })
    await load()
  }

  const toggleClosure = async () => {
    if (!admission) return
    setPending('closure')
    setNotice(null)
    const result = await setEnrollmentClosure(versionId, !admission.enrollmentClosed).catch(() => null)
    setPending(null)
    if (!result?.ok) setNotice({ kind: 'error', text: `Could not change admission (${result?.error ?? 'the backend could not be reached'}).` })
    await load()
  }

  return (
    <section id="enrollment-admission" data-closed={admission?.enrollmentClosed ?? ''} aria-labelledby="admission-heading" className="border border-slate-800 rounded-xl p-3 bg-slate-900/50 flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="admission-heading" className="text-sm font-semibold text-slate-100">Learners</h2>
        {admission && (
          <>
            <span id="admission-state" className={`text-xs px-2 py-0.5 rounded-lg border ${admission.enrollmentClosed ? 'text-amber-200 border-amber-900/70' : 'text-emerald-200 border-emerald-900/70'}`}>
              {admission.enrollmentClosed ? 'Closed to new Enrollments' : 'Open to new Enrollments'}
            </span>
            <button id="enrollment-closure-btn" onClick={() => void toggleClosure()} disabled={pending !== null}
              className="text-xs bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 border border-slate-700 rounded-lg px-2.5 py-1 cursor-pointer">
              {admission.enrollmentClosed ? `Reopen Version ${versionNumber} to new Enrollments` : `Close Version ${versionNumber} to new Enrollments`}
            </button>
          </>
        )}
      </div>
      <p className="text-xs text-slate-400">
        An Invitation offers Version {versionNumber} only, to one email address; only an Account with that verified email can accept it. Invitations do not expire.
        Closing stops pending Invitations from creating new Enrollments; learners already enrolled continue as they are.
      </p>
      <form id="invite-form" onSubmit={(event) => void invite(event)} className="flex flex-wrap items-center gap-2">
        <label className="text-xs text-slate-300 flex items-center gap-2">
          Invite by email
          <input id="invite-email-input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="learner@example.com"
            className="bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1 text-sm text-slate-100 w-64" />
        </label>
        <button id="send-invitation-btn" type="submit" disabled={pending !== null}
          className="text-xs font-medium bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white rounded-lg px-2.5 py-1 cursor-pointer">
          {pending === 'invite' ? 'Sending…' : 'Send invitation'}
        </button>
      </form>
      {notice && (
        <p id="admission-notice" data-kind={notice.kind} data-answer={answers} role={notice.kind === 'sent' ? 'status' : 'alert'}
          className={`text-xs ${notice.kind === 'sent' ? 'text-emerald-300' : notice.kind === 'undelivered' ? 'text-amber-300' : 'text-red-300'}`}>
          {notice.text}
        </p>
      )}
      {loadError && <p id="admission-error" role="alert" className="text-xs text-red-300">Could not load Invitations ({loadError}).</p>}
      {admission && admission.invitations.length > 0 && (
        <ul id="invitation-list" className="flex flex-col gap-1">
          {admission.invitations.map((invitation) => (
            <li key={invitation.id} id={`invitation-${invitation.id}`} data-email={invitation.email} data-delivery={invitation.delivery.status} data-accepted={invitation.acceptedAt !== null}
              className="text-xs text-slate-300 flex flex-wrap items-center gap-2 border-l-2 border-slate-700 pl-2">
              <span className="text-slate-100">{invitation.email}</span>
              <span className={invitation.delivery.status === 'sent' ? 'text-slate-500' : 'text-amber-300'}>
                {invitation.delivery.status === 'sent' ? `emailed ${new Date(invitation.delivery.deliveredAt!).toLocaleString()}`
                  : invitation.delivery.status === 'failed' ? 'email not delivered'
                  : invitation.delivery.status === 'logged' ? 'email not sent (no email provider configured)' : 'email not sent yet'}
              </span>
              <span className={invitation.acceptedAt ? 'text-emerald-300' : 'text-slate-500'}>
                {invitation.acceptedAt ? `accepted ${new Date(invitation.acceptedAt).toLocaleString()}` : 'not accepted'}
              </span>
              <button id={`resend-invitation-${invitation.id}`} onClick={() => void resend(invitation.id)} disabled={pending !== null}
                className="text-sky-300 hover:text-sky-200 disabled:opacity-50 cursor-pointer">
                {pending === invitation.id ? 'Sending…' : 'Send again'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
