import { afterAll, beforeAll, beforeEach, expect, it } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { createApp } from '../src/app'
import type { Database } from '../src/db/client'
import { archivedCoachSkills, personalTasks } from '../src/db/schema'
import { FIXTURE_IDENTITY_HEADER, fixtureIdentity } from '../src/identity'
import { prepareTestDatabase, resetTestDatabase } from './support/database'
import { seedEnrollmentFixture, seedPersonalFixture, type EnrollmentFixture, type PersonalFixture } from './support/fixtures'

/**
 * Skill archival (CONTEXT.md: Archival) through the request boundary on PostgreSQL: a
 * disconnected Skill leaves active use, as a revision-checked action, while its history stays.
 * A personal Skill keeps its Tasks, completion, XP and Mastery records; a Coach Draft Skill
 * leaves only the Draft, with its definition retained immutably, while published Versions and
 * their learners are untouched. An archived Skill cannot be restored or edited by a save.
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
  const body = await r.json().catch(() => null) as any
  expect({ status: r.status, body }).toMatchObject({ status })
  return body
}

const personal = (path = px.paths.main.id) => `/personal/learning-paths/${path}`
const coach = (path = fx.paths.path.id) => `/coach/learning-paths/${path}`
const save = (route: string, doc: any, change: (d: any) => void = () => {}, actor: Actor = 'learner') => {
  const next = structuredClone(doc)
  change(next)
  return request(route, actor, 'PUT', { expectedRevision: doc.learningPath.revision, title: next.learningPath.title, goal: next.learningPath.goal, editor: next.editor, application: next.application })
}
const disconnect = (skillId: string) => (d: any) => { d.editor.connections = d.editor.connections.filter((c: any) => c.from_id !== skillId && c.to_id !== skillId) }
const personalState = async () => (await json(request(`${personal()}/learning-state`, 'learner'), 200)).learningState
const archivePersonalSkill = (skillId: string, body: unknown, actor: Actor = 'learner') => request(`${personal()}/skills/${skillId}/archive`, actor, 'POST', body)
const archiveDraftSkill = (skillId: string, body: unknown, actor: Actor = 'coach') => request(`${coach()}/draft/skills/${skillId}/archive`, actor, 'POST', body)

it('a personal Skill is archived only once disconnected, keeping its Tasks, completion, XP and Mastery', async () => {
  const { skillA, skillB } = px.skills
  // History: a completed 20-XP Task, declared Mastery, and an opened board.
  await json(request(`${personal()}/tasks/${px.tasks.taskA.id}/completion`, 'learner', 'PUT'), 200)
  await json(request(`${personal()}/skills/${skillA.id}/mastery`, 'learner', 'PUT'), 200)
  await json(request(`${personal()}/skills/${skillA.id}/board`, 'learner'), 200)
  let doc = await json(request(personal(), 'learner'), 200)
  const before = await personalState()

  // Connected (A → B): refused and nothing changes.
  expect(await json(archivePersonalSkill(skillA.id, { expectedRevision: doc.learningPath.revision }), 409)).toMatchObject({ error: 'skill_has_prerequisites' })
  expect(await json(request(personal(), 'learner'), 200)).toEqual(doc)
  // Malformed requests are refused for the owner and not found for anyone else.
  expect((await json(archivePersonalSkill(skillA.id, {}), 422)).error).toBe('invalid_request')
  for (const actor of ['peer', 'coach'] as const) expect((await json(archivePersonalSkill(skillA.id, { expectedRevision: doc.learningPath.revision }, actor), 404)).error).toBe('learning_path_not_found')
  expect((await archivePersonalSkill(skillA.id, { expectedRevision: doc.learningPath.revision }, null)).status).toBe(401)

  doc = await json(save(`${personal()}/document`, doc, disconnect(skillA.id)), 200)
  // A stale revision answers the current document and archives nothing.
  expect(await json(archivePersonalSkill(skillA.id, { expectedRevision: doc.learningPath.revision - 1 }), 409)).toMatchObject({ error: 'stale_revision', current: { learningPath: { revision: doc.learningPath.revision } } })
  const archived = await json(archivePersonalSkill(skillA.id, { expectedRevision: doc.learningPath.revision }), 200)
  expect(archived.changed).toBe(true)
  const after = archived.document
  expect(after.learningPath.revision).toBe(doc.learningPath.revision + 1)
  expect(after.application.skills.map((s: any) => s.id)).toEqual([skillB.id])
  expect(after.editor.cards.map((c: any) => c.id)).toEqual([skillB.id])
  expect(after.archivedSkills).toEqual([{ id: skillA.id, title: 'Ownership', outcome: 'Ownership outcome', archivedAt: expect.any(String), taskCount: 2 }])
  // Its records stay: XP, completion and the Mastery history; its Tasks are archived, not deleted.
  const state = await personalState()
  expect(state.xp).toBe(before.xp)
  expect(state.masteryHistory).toEqual(before.masteryHistory)
  expect(state.tasks.find((t: any) => t.taskId === px.tasks.taskA.id)).toMatchObject({ completed: true, xpContribution: 20, archivedAt: expect.any(String) })
  const rows = await db.select().from(personalTasks).where(and(eq(personalTasks.learningPathId, px.paths.main.id), eq(personalTasks.skillId, skillA.id)))
  expect(rows).toHaveLength(2)
  expect(rows.every((row) => row.archivedAt !== null)).toBe(true)

  // A repeat changes nothing; the archived Skill takes no learning action, board or edit.
  expect((await json(archivePersonalSkill(skillA.id, { expectedRevision: after.learningPath.revision }), 200)).changed).toBe(false)
  expect((await request(`${personal()}/skills/${skillA.id}/board`, 'learner')).status).toBe(404)
  expect((await json(request(`${personal()}/skills/${skillA.id}/mastery`, 'learner', 'DELETE'), 409)).error).toBe('skill_archived')
  const restore = (d: any) => {
    d.application.skills.push({ id: skillA.id, title: 'Ownership', outcome: 'back', tasks: [] })
    d.editor.cards.push({ id: skillA.id, title: 'Ownership', position: { x: 0, y: 0 } })
  }
  expect((await json(save(`${personal()}/document`, after, restore), 409)).error).toBe('skill_archived')
  expect(await json(request(personal(), 'learner'), 200)).toEqual(after)
})

it('a Coach Draft Skill is archived from the Draft only: published Versions, Enrollments and evidence stay, and it cannot come back', async () => {
  const { skillA, skillB, taskA } = fx.content
  // A learner of Version 1 has an approved revision of Skill A's Task.
  const enrollment = (await json(request(`/invitations/${fx.invitations.toLearner.id}/accept`, 'learner', 'POST'), 201)).enrollment.id
  const sent = await json(request(`/enrollments/${enrollment}/tasks/${taskA.id}/submission/revisions`, 'learner', 'POST', { text: 'work', urls: [] }), 201)
  await json(request(`/enrollments/${enrollment}/tasks/${taskA.id}/submission/revisions/${sent.revision.id}/review`, 'coach', 'POST', { decision: 'approval' }), 201)
  const v1 = await json(request(`/coach/learning-path-versions/${fx.versions.version1.id}`, 'coach'), 200)
  const learnerBefore = { version: await json(request(`/enrollments/${enrollment}/version`, 'learner'), 200), state: await json(request(`/enrollments/${enrollment}/learning-state`, 'learner'), 200) }

  // Without an open Draft there is nothing to archive from.
  let doc = await json(request(coach(), 'coach'), 200)
  expect((await json(archiveDraftSkill(skillA.id, { expectedRevision: doc.learningPath.revision }), 409)).error).toBe('no_open_draft')
  doc = await json(request(`${coach()}/drafts`, 'coach', 'POST', { expectedRevision: doc.learningPath.revision }), 201)
  const draftId = doc.draft.id
  await json(request(`${coach()}/drafts/${draftId}/skills/${skillA.id}/board`, 'coach'), 200)
  // Connected in the Draft (A → B): refused.
  doc = await json(save(`${coach()}/draft`, doc, (d) => { d.editor.connections.push({ from_id: skillA.id, to_id: skillB.id }) }, 'coach'), 200)
  expect((await json(archiveDraftSkill(skillA.id, { expectedRevision: doc.learningPath.revision }), 409)).error).toBe('skill_has_prerequisites')
  for (const actor of ['learner', 'otherCoach'] as const) expect((await archiveDraftSkill(skillA.id, { expectedRevision: doc.learningPath.revision }, actor)).status).toBe(404)
  doc = await json(save(`${coach()}/draft`, doc, disconnect(skillA.id), 'coach'), 200)
  expect((await json(archiveDraftSkill(skillA.id, { expectedRevision: doc.learningPath.revision - 1 }), 409)).error).toBe('stale_revision')

  const after = await json(archiveDraftSkill(skillA.id, { expectedRevision: doc.learningPath.revision }), 200)
  expect(after.learningPath.revision).toBe(doc.learningPath.revision + 1)
  expect(after.application.skills.map((s: any) => s.id)).toEqual([skillB.id])
  expect(after.archivedSkills).toEqual([{ id: skillA.id, title: 'Vectors (revised)', outcome: 'Add and scale vectors in R^n', archivedAt: expect.any(String), taskCount: 2 }])
  // Its Draft board went with it; a repeat changes nothing.
  expect((await request(`${coach()}/drafts/${draftId}/skills/${skillA.id}/board`, 'coach')).status).toBe(404)
  expect((await json(archiveDraftSkill(skillA.id, { expectedRevision: after.learningPath.revision }), 200)).learningPath.revision).toBe(after.learningPath.revision)
  // The retained definition is immutable history.
  await expect((async () => db.update(archivedCoachSkills).set({ definition: { title: 'x' } as never }).where(eq(archivedCoachSkills.skillId, skillA.id)))()).rejects.toThrow()
  // A Draft save cannot bring it back.
  const restore = (d: any) => {
    d.application.skills.push({ id: skillA.id, title: 'Vectors', outcome: 'back', optional: false, xpThreshold: 0, tasks: [] })
    d.editor.cards.push({ id: skillA.id, title: 'Vectors', position: { x: 0, y: 0 } })
  }
  expect((await json(save(`${coach()}/draft`, after, restore, 'coach'), 409)).error).toBe('skill_archived')

  // Version 1 and its learner are unchanged; the next Version is published without the archived Skill.
  const published = await json(request(`${coach()}/publication`, 'coach', 'POST', { expectedRevision: after.learningPath.revision }), 200)
  const v3 = await json(request(`/coach/learning-path-versions/${published.version.id}`, 'coach'), 200)
  expect(v3.application.skills.map((s: any) => s.id)).toEqual([skillB.id])
  const v1After = await json(request(`/coach/learning-path-versions/${fx.versions.version1.id}`, 'coach'), 200)
  expect({ editor: v1After.editor, application: v1After.application }).toEqual({ editor: v1.editor, application: v1.application })
  expect(await json(request(`/enrollments/${enrollment}/version`, 'learner'), 200)).toEqual(learnerBefore.version)
  expect(await json(request(`/enrollments/${enrollment}/learning-state`, 'learner'), 200)).toEqual(learnerBefore.state)
})
