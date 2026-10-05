import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ContextHeader } from '../components/workspace/ContextHeader'
import { acceptInvitation, readAccount, readInvitation, sendVerificationEmail, signOut, type Account, type EnrollmentSummary, type InvitationOffer } from '../lib/api'
import { onSessionChange } from '../lib/session'

/**
 * An Enrollment Invitation as its emailed link opens it (CONTEXT.md). Only an Account
 * whose verified email matches may see the offer and accept it; acceptance joins that
 * one Version and nothing else. Every outcome shown is the backend's answer: an
 * Enrollment created or already held (status unchanged), or why it was refused.
 * Invitations have no expiry, so none is shown or enforced here.
 */
export const Route = createFileRoute('/invitations/$invitationId')({ component: InvitationPage })

type View =
  | { state: 'loading' }
  | { state: 'signed-out' }
  | { state: 'offer'; account: Account; offer: InvitationOffer; enrollment: EnrollmentSummary | null }
  | { state: 'refused'; account: Account; refusal: string }
  | { state: 'failed'; account: Account | null; error: string }

type Outcome =
  | { kind: 'enrolled'; created: boolean; enrollment: EnrollmentSummary; offer: InvitationOffer }
  | { kind: 'refused'; refusal: string }

const REFUSALS: Record<string, (account: Account) => string> = {
  email_not_verified: (account) => `Your email ${account.email} is not verified yet. Only an Account with the invited, verified email address can accept this Invitation.`,
  email_mismatch: (account) => `This Invitation is addressed to a different email than ${account.email}. Sign in with the invited address to accept it.`,
  invitation_not_found: () => 'This Invitation does not exist. Check the link in your email.',
  owner_cannot_enroll: () => 'You own the Coach Workspace offering this Version. A Coach cannot enroll as a learner in their own Workspace.',
  enrollment_closed: () => 'This Version is closed to new Enrollments, so the Invitation cannot enroll you now. It stays valid if the Coach reopens the Version.',
  version_not_published: () => 'This Version is not published, so it cannot be joined.',
  backend_unreachable: () => 'Gurow could not be reached, so nothing was accepted. Check your connection and try again.',
}
const explain = (refusal: string, account: Account) => REFUSALS[refusal]?.(account) ?? `The Invitation could not be accepted (${refusal}).`

function InvitationPage() {
  const { invitationId } = Route.useParams()
  const navigate = useNavigate()
  const returnTo = `/invitations/${invitationId}`
  const [view, setView] = useState<View>({ state: 'loading' })
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  // Numbers each acceptance answer, so a repeated answer still reads as a new one.
  const [attempt, setAttempt] = useState(0)
  const [pending, setPending] = useState(false)
  const [verification, setVerification] = useState<string | null>(null)

  const load = useCallback(async () => {
    setView({ state: 'loading' })
    setOutcome(null)
    setVerification(null)
    let signedIn: Account | null = null
    try {
      const account = await readAccount()
      if (!account.ok) return setView({ state: 'signed-out' })
      signedIn = account.value.account
      const result = await readInvitation(invitationId)
      if (result.ok) setView({ state: 'offer', account: signedIn, ...result.value })
      else if (result.status === 401) setView({ state: 'signed-out' })
      else if (result.status === 403 || result.status === 404) setView({ state: 'refused', account: signedIn, refusal: result.error })
      else setView({ state: 'failed', account: signedIn, error: result.error })
    } catch {
      // A request that never got an answer: say so instead of waiting forever.
      setView({ state: 'failed', account: signedIn, error: 'the backend could not be reached' })
    }
  }, [invitationId])

  useEffect(() => { void load() }, [load])
  // Another tab's sign-in or sign-out changes who would accept: read the Invitation again,
  // but keep a shown answer while the session is still the same Account's.
  const shownAccountId = useRef<string | null>(null)
  shownAccountId.current = view.state === 'loading' || view.state === 'signed-out' ? null : view.account?.id ?? null
  useEffect(() => onSessionChange(async (reason) => {
    const account = await readAccount().catch(() => null)
    const id = account?.ok ? account.value.account.id : null
    if (reason === 'announced' || id !== shownAccountId.current) await load()
  }), [load])

  const accept = async () => {
    setPending(true)
    const result = await acceptInvitation(invitationId).catch(() => null)
    setPending(false)
    setAttempt((n) => n + 1)
    if (result?.ok) setOutcome({ kind: 'enrolled', created: result.value.created, enrollment: result.value.enrollment, offer: result.value.offer })
    else setOutcome({ kind: 'refused', refusal: result?.error ?? 'backend_unreachable' })
  }

  const verify = async (account: Account) => {
    setPending(true)
    const result = await sendVerificationEmail(account.email, returnTo).catch(() => null)
    setPending(false)
    setVerification(result?.ok ? `A verification email was requested for ${account.email}. When it arrives, open its link to verify the address and return here.` : `The verification email could not be requested (${result?.error ?? 'the backend could not be reached'}).`)
  }

  const handleSignOut = async () => {
    await signOut().catch(() => null)
    await load()
  }

  const account = view.state === 'loading' || view.state === 'signed-out' ? null : view.account
  // Accepting can be tried again only when the last try never reached the backend.
  const canAccept = !outcome || (outcome.kind === 'refused' && outcome.refusal === 'backend_unreachable')
  return (
    <main className="w-full h-full flex flex-col bg-slate-950" data-account-id={account?.id ?? ''}>
      <ContextHeader account={account} onSignOut={() => void handleSignOut()} context={{ kind: 'learner' }} />
      <section className="flex-1 overflow-y-auto flex items-start justify-center p-6">
        <div id="invitation" data-state={view.state} className="w-full max-w-lg bg-slate-900/80 border border-slate-800 rounded-xl p-6 flex flex-col gap-3">
          <h1 className="text-lg font-semibold text-slate-100">Enrollment Invitation</h1>
          {view.state === 'loading' && <p className="text-sm text-slate-500">Checking the Invitation…</p>}

          {view.state === 'signed-out' && (
            <>
              <p className="text-sm text-slate-300">You were invited to join a Learning Path with a Coach on Gurow.</p>
              <p className="text-xs text-slate-400">Sign in, or create an Account, with the email address this Invitation was sent to. You will return here afterwards.</p>
              <button id="invitation-sign-in" onClick={() => void navigate({ to: '/', search: { next: returnTo } })}
                className="self-start bg-emerald-600 hover:bg-emerald-500 text-white text-sm rounded-lg px-3 py-1.5 cursor-pointer">
                Sign in to accept
              </button>
            </>
          )}

          {view.state === 'offer' && (
            <>
              <dl id="invitation-offer" data-version-id={view.offer.learningPathVersionId} className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-sm">
                <dt className="text-slate-400">Learning Path</dt><dd id="offer-path-title" className="text-slate-100">{view.offer.learningPathTitle}</dd>
                <dt className="text-slate-400">Version</dt><dd id="offer-version" className="text-slate-100">Version {view.offer.versionNumber}</dd>
                <dt className="text-slate-400">Coach Workspace</dt><dd id="offer-workspace" className="text-slate-100">{view.offer.coachWorkspaceName}</dd>
              </dl>
              <p className="text-xs text-slate-400">Accepting enrolls {view.account.email} in this Version only, not in other Learning Paths of the Workspace or in later Versions.</p>
              {view.enrollment && canAccept && (
                <p id="existing-enrollment" data-status={view.enrollment.status} className="text-xs text-slate-300">
                  You already hold an Enrollment in this Version ({view.enrollment.status}). Accepting again keeps it and its progress.
                </p>
              )}
              {canAccept && (
                <button id="accept-invitation-btn" onClick={() => void accept()} disabled={pending}
                  className="self-start bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm rounded-lg px-3 py-1.5 cursor-pointer">
                  {pending ? 'Accepting…' : 'Accept invitation'}
                </button>
              )}
            </>
          )}

          {view.state === 'refused' && (
            <div id="invitation-refused" data-refusal={view.refusal} role="alert" className="flex flex-col gap-2">
              <p className="text-sm text-amber-200">{explain(view.refusal, view.account)}</p>
              {view.refusal === 'email_not_verified' && (
                <>
                  <button id="send-verification-btn" onClick={() => void verify(view.account)} disabled={pending}
                    className="self-start bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 text-sm rounded-lg px-3 py-1.5 border border-slate-700 cursor-pointer">
                    Send a verification email
                  </button>
                  {verification && <p id="verification-notice" role="status" className="text-xs text-slate-300">{verification}</p>}
                </>
              )}
            </div>
          )}

          {view.state === 'failed' && (
            <div className="flex flex-col gap-2">
              <p id="invitation-error" role="alert" className="text-sm text-red-300">Could not read the Invitation ({view.error}).</p>
              <button id="invitation-retry" onClick={() => void load()}
                className="self-start bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm rounded-lg px-3 py-1.5 border border-slate-700 cursor-pointer">
                Try again
              </button>
            </div>
          )}

          {outcome?.kind === 'enrolled' && (
            <div id="invitation-result" data-attempt={attempt} data-outcome={outcome.created ? 'enrolled' : 'already-enrolled'} data-enrollment-id={outcome.enrollment.id} data-status={outcome.enrollment.status}
              role="status" className="flex flex-col gap-1 border border-emerald-900/70 rounded-lg p-3">
              <p className="text-sm text-emerald-200">
                {outcome.created
                  ? `You are enrolled in ${outcome.offer.learningPathTitle}, Version ${outcome.offer.versionNumber}.`
                  : `You were already enrolled in ${outcome.offer.learningPathTitle}, Version ${outcome.offer.versionNumber}. Your Enrollment and its progress are unchanged.`}
              </p>
              {outcome.enrollment.status === 'inactive' && (
                <p id="enrollment-inactive" className="text-xs text-amber-200">This Enrollment is inactive. Accepting an Invitation does not reactivate it; only the Coach can.</p>
              )}
              <Link id="open-enrollment" to="/enrollments/$enrollmentId" params={{ enrollmentId: outcome.enrollment.id }} className="self-start text-xs text-violet-300 hover:text-violet-200">
                Open {outcome.offer.learningPathTitle}, Version {outcome.offer.versionNumber}
              </Link>
            </div>
          )}
          {outcome?.kind === 'refused' && account && (
            <p id="invitation-result" data-attempt={attempt} data-outcome={outcome.refusal} role="alert" className="text-sm text-amber-200 border border-amber-900/70 rounded-lg p-3">
              {explain(outcome.refusal, account)}
            </p>
          )}
          {account && <Link to="/" className="self-start text-xs text-sky-300 hover:text-sky-200">Go to your Personal Workspace</Link>}
        </div>
      </section>
    </main>
  )
}
