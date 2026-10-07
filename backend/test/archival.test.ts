import { afterAll, beforeAll, beforeEach, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { createApp } from '../src/app'
import type { Database } from '../src/db/client'
import { versionTasks } from '../src/db/schema'
import { FIXTURE_IDENTITY_HEADER, fixtureIdentity } from '../src/identity'
import { prepareTestDatabase, resetTestDatabase } from './support/database'
import { amendPublished, seedEnrollmentFixture, seedPersonalFixture, type EnrollmentFixture, type PersonalFixture } from './support/fixtures'

/**
 * T30 (#31): archiving learning content with history (ADR 0018) through the request
 * boundary on PostgreSQL. Content with progress history is never deleted: a personal
 * Task is archived with its records, and a published Task leaves only a later Draft,
 * while the Versions holding it and their Enrollments keep it with their evidence.
 */
let db: Database, close: () => Promise<void>, fx: EnrollmentFixture, px: PersonalFixture, app: ReturnType<typeof createApp>
beforeAll(async () => { ({ db, close } = await prepareTestDatabase()) })
afterAll(async () => { await close() })
beforeEach(async () => {
  await resetTestDatabase(db)
  fx = await seedEnrollmentFixture(db)
  px = await seedPersonalFixture(db, fx)
  app = createApp({ db, identity: fixtureIdentity(fx.identities) })
})

type Actor = keyof EnrollmentFixture['identities'] | null
async function request(path: string, actor: Actor, method = 'GET', body?: unknown) {
  return app.request(path, { method, headers: { ...(actor ? { [FIXTURE_IDENTITY_HEADER]: actor } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
}
async function json(response: Response | Promise<Response>, status: number) {
  const r = await response
  const body = await r.json() as any
  expect({ status: r.status, body }).toMatchObject({ status })
  return body
}

interface Doc {
  learningPath: { id: string; title: string; goal: string; revision: number }
  editor: { format_version: 1; cards: { id: string; title: string; position: { x: number; y: number } }[]; connections: { from_id: string; to_id: string }[] }
  application: { skills: { id: string; title: string; outcome: string; tasks: { id: string; title: string; description: string; required?: boolean; xpReward?: number }[] }[] }
}
const personal = (path = px.paths.main.id) => `/personal/learning-paths/${path}`
const coach = (path = fx.paths.path.id) => `/coach/learning-paths/${path}`
const edit = (doc: Doc, change: (d: Doc) => void, expectedRevision = doc.learningPath.revision) => {
  const next = structuredClone(doc)
  change(next)
  return { expectedRevision, title: next.learningPath.title, goal: next.learningPath.goal, editor: next.editor, application: next.application }
}
const withoutTask = (taskId: string) => (d: Doc) => { for (const skill of d.application.skills) skill.tasks = skill.tasks.filter((t) => t.id !== taskId) }
const withoutSkill = (skillId: string) => (d: Doc) => {
  d.application.skills = d.application.skills.filter((s) => s.id !== skillId)
  d.editor.cards = d.editor.cards.filter((c) => c.id !== skillId)
  d.editor.connections = d.editor.connections.filter((c) => c.from_id !== skillId && c.to_id !== skillId)
}
const archivePersonal = (taskId: string, body?: unknown, actor: Actor = 'learner', path = px.paths.main.id) => request(`${personal(path)}/tasks/${taskId}/archive`, actor, 'POST', body)
const archiveDraft = (taskId: string, expectedRevision: unknown, actor: Actor = 'coach', path = fx.paths.path.id) => request(`${coach(path)}/draft/tasks/${taskId}/archive`, actor, 'POST', { expectedRevision })
/** What a Version publishes: its title, goal and learning content, apart from the Path's revision and Version list. */
const content = (d: any) => ({ title: d.learningPath.title, goal: d.learningPath.goal, version: d.version, editor: d.editor, application: d.application })
const personalState = async (actor: Actor = 'learner') => (await json(request(`${personal()}/learning-state`, actor), 200)).learningState

it('AC1: a personal Task or Skill with history cannot be deleted by a save; it is archived instead', async () => {
  await json(request(`${personal()}/tasks/${px.tasks.taskA.id}/completion`, 'learner', 'PUT'), 200)
  await json(request(`${personal()}/skills/${px.skills.skillB.id}/access-override`, 'learner', 'PUT'), 200)
  const doc: Doc = await json(request(personal(), 'learner'), 200)

  // Completed Task, Skill with a completed Task, Skill with an override: all refused, nothing written.
  expect(await json(request(`${personal()}/document`, 'learner', 'PUT', edit(doc, withoutTask(px.tasks.taskA.id))), 409))
    .toMatchObject({ error: 'task_has_history', detail: 'Task "Borrow checker exercises" has learning history and cannot be deleted; archive it instead' })
  expect(await json(request(`${personal()}/document`, 'learner', 'PUT', edit(doc, withoutSkill(px.skills.skillA.id))), 409)).toMatchObject({ error: 'skill_has_history' })
  expect(await json(request(`${personal()}/document`, 'learner', 'PUT', edit(doc, withoutSkill(px.skills.skillB.id))), 409)).toMatchObject({ error: 'skill_has_history' })
  expect(await json(request(personal(), 'learner'), 200)).toEqual(doc)
  // Unused content is deleted (T32): the unread chapter Task of the same Skill leaves.
  const pruned = await json(request(`${personal()}/document`, 'learner', 'PUT', edit(doc, withoutTask(px.tasks.taskA2.id))), 200)
  expect(pruned.application.skills.flatMap((k: any) => k.tasks.map((t: any) => t.id))).not.toContain(px.tasks.taskA2.id)

  // Archiving it keeps its records readable; afterwards its Skill still cannot be deleted.
  const archived = await json(archivePersonal(px.tasks.taskA.id), 200)
  expect(archived.learningState.tasks.find((t: any) => t.taskId === px.tasks.taskA.id)).toMatchObject({ completed: true, xpContribution: 20, archivedAt: expect.any(String) })
  const after: Doc = archived.document
  expect(after.learningPath.revision).toBe(pruned.learningPath.revision + 1)
  expect(await json(request(`${personal()}/document`, 'learner', 'PUT', edit(after, withoutSkill(px.skills.skillA.id))), 409)).toMatchObject({ error: 'skill_has_history' })
})

it('AC2: archiving a personal Task keeps its contribution, Mastery and history, advances the revision and has no way back', async () => {
  await json(request(`${personal()}/tasks/${px.tasks.taskA.id}/completion`, 'learner', 'PUT'), 200)
  await json(request(`${personal()}/skills/${px.skills.skillA.id}/mastery`, 'learner', 'PUT'), 200)
  const before = await personalState()
  const doc: Doc = await json(request(personal(), 'learner'), 200)

  // Based on an older revision, nothing is archived and the accepted document comes back.
  const stale = await json(archivePersonal(px.tasks.taskA.id, { expectedRevision: doc.learningPath.revision + 1 }), 409)
  expect(stale).toMatchObject({ error: 'stale_revision', current: doc })
  expect(await personalState()).toEqual(before)

  const archived = await json(archivePersonal(px.tasks.taskA.id, { expectedRevision: doc.learningPath.revision }), 200)
  expect(archived.changed).toBe(true)
  expect(archived.document.learningPath.revision).toBe(doc.learningPath.revision + 1)
  const ownTasks = (d: Doc) => d.application.skills.find((k) => k.id === px.skills.skillA.id)!.tasks.map((t) => t.id)
  expect(ownTasks(archived.document)).toEqual(ownTasks(doc).filter((id) => id !== px.tasks.taskA.id))
  expect(ownTasks(doc)).toContain(px.tasks.taskA.id)
  const s = archived.learningState
  expect(s.xp).toBe(before.xp)
  expect(s.xpHistory).toEqual(before.xpHistory)
  expect(s.masteryHistory).toEqual(before.masteryHistory)
  expect(s.skills.find((k: any) => k.skillId === px.skills.skillA.id).mastery).toBe(true)
  // Lifetimes stays open: its threshold still counts the archived Task's 20 XP.
  expect(s.skills.find((k: any) => k.skillId === px.skills.skillB.id)).toMatchObject({ xpShortfall: 0, unmetPrerequisiteSkillIds: [] })
  expect(await json(request(personal(), 'learner'), 200)).toEqual(archived.document)

  // Repeating changes nothing, not even the revision; no action reaches the archived Task.
  const again = await json(archivePersonal(px.tasks.taskA.id), 200)
  expect(again.changed).toBe(false)
  expect(again.document.learningPath.revision).toBe(archived.document.learningPath.revision)
  for (const [method, action, body] of [['PUT', 'completion'], ['DELETE', 'completion'], ['PUT', 'reward', { xpReward: 5 }], ['POST', 'start']] as const) {
    expect(await json(request(`${personal()}/tasks/${px.tasks.taskA.id}/${action}`, 'learner', method, body), 409)).toEqual({ error: 'task_archived' })
  }
  expect((await request(`${personal()}/tasks/${px.tasks.taskA.id}/archive`, 'learner', 'DELETE')).status).toBe(404)
  // A tab still on the old revision is stale; a save sending the archived Task back is refused.
  expect(await json(request(`${personal()}/document`, 'learner', 'PUT', edit(doc, () => {})), 409)).toMatchObject({ error: 'stale_revision' })
  const archivedTask = doc.application.skills.flatMap((k) => k.tasks).find((t) => t.id === px.tasks.taskA.id)!
  const restored = edit(archived.document, (d) => { d.application.skills.find((k) => k.id === px.skills.skillA.id)!.tasks.push(archivedTask) })
  expect(await json(request(`${personal()}/document`, 'learner', 'PUT', restored), 409)).toMatchObject({ error: 'task_archived' })
  expect(await personalState()).toEqual({ ...s })
})

it('AC3: archived personal content stays owner-only', async () => {
  await json(archivePersonal(px.tasks.taskA.id), 200)
  for (const actor of ['peer', 'coach', 'unrelated'] as const) {
    expect((await archivePersonal(px.tasks.taskA2.id, undefined, actor)).status).toBe(404)
    expect((await request(`${personal()}/learning-state`, actor)).status).toBe(404)
  }
  expect((await archivePersonal(px.tasks.taskA2.id, undefined, null)).status).toBe(401)
  // Another Account's Task is unknown in the owner's Path too.
  expect(await json(archivePersonal(px.tasks.peerTask.id), 404)).toEqual({ error: 'task_not_found' })
  expect(await json(archivePersonal(px.tasks.taskA2.id, { expectedRevision: 'x' }), 422)).toMatchObject({ error: 'invalid_request' })
  expect((await archivePersonal(px.tasks.taskA2.id, { expectedRevision: 'x' }, 'peer')).status).toBe(404)
  const s = await personalState()
  expect(s.tasks.filter((t: any) => t.archivedAt).map((t: any) => t.taskId)).toEqual([px.tasks.taskA.id])
})

it('AC1/AC2/AC3/AC4: a published Task leaves only a later Draft; earlier Versions and their Enrollments keep it with their evidence', async () => {
  await amendPublished(db, (tx) => tx.update(versionTasks).set({ xpReward: 20 }).where(eq(versionTasks.learningPathVersionId, fx.versions.version1.id)))
  const enrollment = (await json(request(`/invitations/${fx.invitations.toLearner.id}/accept`, 'learner', 'POST'), 201)).enrollment.id
  const task = (taskId: string) => `/enrollments/${enrollment}/tasks/${taskId}`
  const sent = await json(request(`${task(fx.content.taskA.id)}/submission/revisions`, 'learner', 'POST', { text: 'Vectors done', urls: [] }), 201)
  await json(request(`${task(fx.content.taskA.id)}/submission/revisions/${sent.revision.id}/review`, 'coach', 'POST', { decision: 'approval' }), 201)
  await json(request(`${task(fx.content.taskAReading.id)}/submission/revisions`, 'learner', 'POST', { text: 'Chapter 1 notes', urls: [] }), 201)
  await json(request(`${task(fx.content.taskAReading.id)}/draft`, 'learner', 'PUT', { text: 'Unsent second thoughts', urls: [] }), 200)
  const progress = (await json(request(`/enrollments/${enrollment}/learning-state`, 'learner'), 200)).learningState
  expect(progress.xp).toBe(20)
  const version1 = await json(request(`/coach/learning-path-versions/${fx.versions.version1.id}`, 'coach'), 200)
  const version2 = await json(request(`/coach/learning-path-versions/${fx.versions.version2.id}`, 'coach'), 200)

  // Without an open Draft, nothing is archived: published content is not changed in place.
  const published = await json(request(coach(), 'coach'), 200)
  expect(await json(archiveDraft(fx.content.taskAReading.id, published.learningPath.revision), 409)).toMatchObject({ error: 'no_open_draft' })

  const draft = await json(request(`${coach()}/drafts`, 'coach', 'POST', { expectedRevision: published.learningPath.revision }), 201)
  // A save that drops published content is refused in favour of archival.
  expect(await json(request(`${coach()}/draft`, 'coach', 'PUT', edit(draft, withoutTask(fx.content.taskAReading.id))), 409))
    .toMatchObject({ error: 'task_has_history', detail: 'Task "Read chapter 1" is part of a published Version and cannot be deleted; archive it from this Draft instead' })
  expect(await json(request(`${coach()}/draft`, 'coach', 'PUT', edit(draft, withoutSkill(fx.content.skillB.id))), 409)).toMatchObject({ error: 'skill_has_history' })

  // Only the owning Coach archives, from the revision they saw, and only a published Task.
  for (const actor of ['learner', 'otherCoach', 'peer'] as const) expect((await archiveDraft(fx.content.taskAReading.id, draft.learningPath.revision, actor)).status).toBe(404)
  expect(await json(archiveDraft(fx.content.taskAReading.id, draft.learningPath.revision - 1), 409)).toMatchObject({ error: 'stale_revision', current: draft })
  expect(await json(archiveDraft(crypto.randomUUID(), draft.learningPath.revision), 404)).toMatchObject({ error: 'task_not_found' })
  const fresh = crypto.randomUUID()
  const withNew = await json(request(`${coach()}/draft`, 'coach', 'PUT', edit(draft, (d) => { d.application.skills[0].tasks.push({ id: fresh, title: 'Draft-only Task', description: '', required: false, xpReward: 0 }) })), 200)
  expect(await json(archiveDraft(fresh, withNew.learningPath.revision), 409)).toMatchObject({ error: 'task_not_published' })

  const archived = await json(archiveDraft(fx.content.taskAReading.id, withNew.learningPath.revision), 200)
  expect(archived.learningPath.revision).toBe(withNew.learningPath.revision + 1)
  expect(archived.application.skills.flatMap((k: any) => k.tasks.map((t: any) => t.title)).sort()).toEqual(['Draft-only Task', 'Matrix exercises (revised)', 'Vector exercises (revised)'])
  expect(await json(request(coach(), 'coach'), 200)).toEqual(archived)

  // Publishing carries the archival forward; Versions 1 and 2 still hold the Task as published.
  const v3 = await json(request(`${coach()}/publication`, 'coach', 'POST', { expectedRevision: archived.learningPath.revision }), 200)
  expect(v3.application.skills.flatMap((k: any) => k.tasks.map((t: any) => t.title)).sort()).toEqual(['Draft-only Task', 'Matrix exercises (revised)', 'Vector exercises (revised)'])
  expect(content(version1).application.skills.flatMap((k: any) => k.tasks.map((t: any) => t.title))).toContain('Read chapter 1')
  expect(content(await json(request(`/coach/learning-path-versions/${fx.versions.version1.id}`, 'coach'), 200))).toEqual(content(version1))
  expect(content(await json(request(`/coach/learning-path-versions/${fx.versions.version2.id}`, 'coach'), 200))).toEqual(content(version2))

  // The Enrollment on Version 1 keeps its XP, Approval and Submissions under the same visibility rules.
  expect((await json(request(`/enrollments/${enrollment}/learning-state`, 'learner'), 200)).learningState).toEqual(progress)
  for (const actor of ['learner', 'coach'] as const) {
    const submission = (await json(request(`${task(fx.content.taskAReading.id)}/submission`, actor), 200)).submission
    expect(submission.revisions.map((r: any) => r.text)).toEqual(['Chapter 1 notes'])
  }
  for (const actor of ['peer', 'otherCoach', 'unrelated'] as const) expect((await request(`${task(fx.content.taskAReading.id)}/submission`, actor)).status).toBe(404)
  expect((await json(request(`${task(fx.content.taskAReading.id)}/draft`, 'learner'), 200)).draft.text).toBe('Unsent second thoughts')
  expect(await json(request(`${task(fx.content.taskAReading.id)}/draft`, 'coach'), 403)).toEqual({ error: 'draft_private' })
})
