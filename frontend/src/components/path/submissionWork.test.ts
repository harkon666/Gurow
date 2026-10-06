import { describe, expect, it } from 'bun:test'
import type { EnrollmentLearningState, SubmissionRevisionView } from '../../lib/api'
import { contentsOf, contentsProblem, draftRecoveryKey, findSentRevision, isEmpty, isRefusal, loadRecoveredDraft, rememberEdits, revisionNote, sameContents, sendBlockedReason } from './submissionWork'

class MemoryStorage implements Storage {
  private items = new Map<string, string>()
  get length() { return this.items.size }
  clear() { this.items.clear() }
  getItem(key: string) { return this.items.get(key) ?? null }
  key(index: number) { return [...this.items.keys()][index] ?? null }
  removeItem(key: string) { this.items.delete(key) }
  setItem(key: string, value: string) { this.items.set(key, value) }
}

describe('local recovery of unsent work', () => {
  it('keys recovery by Account, Enrollment and Task, so another Account never reads it', () => {
    const storage = new MemoryStorage()
    const lena = draftRecoveryKey('lena', 'e1', 't1')
    rememberEdits(storage, lena, { text: 'Lena\'s unsent answer', urls: [] }, null)
    expect(loadRecoveredDraft(storage, lena)).toMatchObject({ text: 'Lena\'s unsent answer', urls: [] })
    expect(loadRecoveredDraft(storage, draftRecoveryKey('pia', 'e1', 't1'))).toBeNull()
    expect(loadRecoveredDraft(storage, draftRecoveryKey('lena', 'e2', 't1'))).toBeNull()
    expect(loadRecoveredDraft(storage, draftRecoveryKey('lena', 'e1', 't2'))).toBeNull()
  })

  it('keeps edits only while they differ from the saved draft', () => {
    const storage = new MemoryStorage()
    const key = draftRecoveryKey('a', 'e', 't')
    const saved = { text: 'v1', urls: ['https://example.com/a'] }
    expect(rememberEdits(storage, key, { text: 'v2', urls: ['https://example.com/a', ''] }, saved, new Date('2026-10-05T10:00:00Z'))).toBe(true)
    expect(loadRecoveredDraft(storage, key)).toEqual({ text: 'v2', urls: ['https://example.com/a', ''], editedAt: '2026-10-05T10:00:00.000Z' })
    // An empty link field is not a link: these edits equal the saved draft.
    expect(rememberEdits(storage, key, { text: 'v1', urls: ['https://example.com/a', ' '] }, saved)).toBe(false)
    expect(storage.getItem(key)).toBeNull()
  })

  it('drops corrupt recovery data instead of showing it', () => {
    const storage = new MemoryStorage()
    storage.setItem('k', '{"text": 3}')
    expect(loadRecoveredDraft(storage, 'k')).toBeNull()
    expect(storage.getItem('k')).toBeNull()
    storage.setItem('k', 'not json')
    expect(loadRecoveredDraft(storage, 'k')).toBeNull()
  })

  it('survives storage that throws', () => {
    const broken = new MemoryStorage()
    broken.setItem = () => { throw new Error('QuotaExceededError') }
    broken.getItem = () => { throw new Error('SecurityError') }
    expect(rememberEdits(broken, 'k', { text: 'x', urls: [] }, null)).toBe(false)
    expect(loadRecoveredDraft(broken, 'k')).toBeNull()
  })
})

describe('contents', () => {
  it('ignores empty link fields and compares the evidence itself', () => {
    expect(contentsOf({ text: ' a ', urls: ['', ' https://x.test/1 '] })).toEqual({ text: ' a ', urls: ['https://x.test/1'] })
    expect(sameContents({ text: 'a', urls: [] }, null)).toBe(false)
    expect(sameContents({ text: '', urls: [''] }, null)).toBe(true)
    expect(isEmpty({ text: '  ', urls: [''] })).toBe(true)
    expect(isEmpty({ text: '', urls: ['https://x.test'] })).toBe(false)
  })

  it('explains contents the backend would refuse', () => {
    expect(contentsProblem({ text: 'ok', urls: ['https://x.test/a'] })).toBeNull()
    expect(contentsProblem({ text: '', urls: ['example.com/page'] })).toContain('not a full http(s) link')
    expect(contentsProblem({ text: '', urls: ['ftp://x.test/file'] })).toContain('not a full http(s) link')
    expect(contentsProblem({ text: 'x'.repeat(50_001), urls: [] })).toContain('longer than')
    expect(contentsProblem({ text: '', urls: Array.from({ length: 21 }, (_, i) => `https://x.test/${i}`) })).toContain('At most 20')
  })
})

const records = (over: Partial<EnrollmentLearningState> = {}, access = true): EnrollmentLearningState => ({
  enrollmentId: 'e', learningPathVersionId: 'v', enrollmentStatus: 'active', xp: 0,
  skills: [{ skillId: 's', title: 'S', learningOutcome: '', optional: false, xpThreshold: 0, mastery: false, access, accessOverride: null, unmetPrerequisiteSkillIds: [], xpShortfall: 0 }],
  tasks: [{ taskId: 't', skillId: 's', title: 'T', required: true, xpReward: 10, approved: false, xpContribution: 0 }],
  xpHistory: [], masteryHistory: [], taskStarts: [], ...over,
})

describe('sending needs Access and an active Enrollment', () => {
  it('allows sending only to an accessible Skill of an active Enrollment', () => {
    expect(sendBlockedReason(records(), 't')).toBeNull()
    expect(sendBlockedReason(records({}, false), 't')).toContain('locked')
    expect(sendBlockedReason(records({ enrollmentStatus: 'inactive' }), 't')).toContain('inactive')
    expect(sendBlockedReason(null, 't')).toContain('not loaded')
    expect(sendBlockedReason(records(), 'other')).not.toBeNull()
  })
})

const revision = (revisionNumber: number, status: SubmissionRevisionView['status']): SubmissionRevisionView =>
  ({ id: `r${revisionNumber}`, revisionNumber, text: '', urls: [], sentAt: '', status })

describe('revision history', () => {
  it('keeps an earlier Approval without passing it to a newer revision', () => {
    const history = [revision(1, 'approval'), revision(2, 'pending')]
    expect(revisionNote(history[0], history)).toContain('counts for the Task')
    expect(revisionNote(history[1], history)).toBe('Needs its own Review: it does not inherit the Approval of Revision 1, which still counts.')
  })

  it('names the revision that superseded an unreviewed one', () => {
    const history = [revision(1, 'changes_requested'), revision(2, 'superseded'), revision(3, 'pending')]
    expect(revisionNote(history[1], history)).toContain('Replaced by Revision 3')
    expect(revisionNote(history[2], history)).toBe('Waiting for your Coach\'s Review.')
    expect(revisionNote(history[0], history)).toContain('new revision')
  })

  it('does not count a revoked Approval for a newer revision', () => {
    const history = [revision(1, 'approval_revoked'), revision(2, 'pending')]
    expect(revisionNote(history[1], history)).toBe('Waiting for your Coach\'s Review.')
  })
})

describe('a send whose answer was lost', () => {
  it('treats only backend refusals as unsent; no answer or a gateway error is unknown', () => {
    expect(isRefusal(403)).toBe(true)
    expect(isRefusal(422)).toBe(true)
    expect(isRefusal(0)).toBe(false)
    expect(isRefusal(502)).toBe(false)
    expect(isRefusal(500)).toBe(false)
  })

  it('finds the revision with the same contents sent after the draft was saved', () => {
    const at = (n: number, text: string, sentAt: string): SubmissionRevisionView => ({ ...revision(n, 'pending'), text, urls: ['https://x.test/a'], sentAt })
    const sent = { text: 'answer', urls: ['https://x.test/a', ''] }
    const history = [at(1, 'answer', '2026-10-05T10:00:00.000Z'), at(2, 'other', '2026-10-05T10:05:00.000Z')]
    // Revision 1 has the same contents but predates this send's draft save.
    expect(findSentRevision(history, sent, '2026-10-05T10:04:00.000Z')).toBeNull()
    const arrived = [...history, at(3, 'answer', '2026-10-05T10:04:00.250Z')]
    expect(findSentRevision(arrived, sent, '2026-10-05T10:04:00.000Z')?.revisionNumber).toBe(3)
  })
})
