import { afterAll, beforeAll, beforeEach, expect, it } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { createApp } from '../src/app'
import type { Database } from '../src/db/client'
import { personalPrerequisites, personalSkillCards, personalSkills, personalTasks, skills, tasks, versionPrerequisites, versionSkillCards, versionSkills, versionTasks } from '../src/db/schema'
import { FIXTURE_IDENTITY_HEADER, fixtureIdentity } from '../src/identity'
import { prepareTestDatabase, resetTestDatabase } from './support/database'
import { seedEnrollmentFixture, seedPersonalFixture, type EnrollmentFixture, type PersonalFixture } from './support/fixtures'

/**
 * T32 (#33): deleting unused learning content through the ordinary revision-checked
 * save, on PostgreSQL. A save that leaves out a Skill or Task without learning history
 * deletes it with its card and connections; content with history is still refused in
 * favour of archival (ADR 0018, 0026). The deleted content's logical IDs stay the
 * Path's, so an editor undo sends it back as a new, validated save.
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
  application: { skills: { id: string; title: string; outcome: string; optional?: boolean; xpThreshold?: number; tasks: { id: string; title: string; description: string; required?: boolean; xpReward?: number }[] }[] }
}
const personal = (path = px.paths.main.id) => `/personal/learning-paths/${path}`
const coach = (path = fx.paths.path.id) => `/coach/learning-paths/${path}`
const edit = (doc: Doc, change: (d: Doc) => void, expectedRevision = doc.learningPath.revision) => {
  const next = structuredClone(doc)
  change(next)
  return { expectedRevision, title: next.learningPath.title, goal: next.learningPath.goal, editor: next.editor, application: next.application }
}
const withoutSkill = (skillId: string) => (d: Doc) => {
  d.application.skills = d.application.skills.filter((s) => s.id !== skillId)
  d.editor.cards = d.editor.cards.filter((c) => c.id !== skillId)
  d.editor.connections = d.editor.connections.filter((c) => c.from_id !== skillId && c.to_id !== skillId)
}
const withoutConnection = (from: string, to: string) => (d: Doc) => { d.editor.connections = d.editor.connections.filter((c) => !(c.from_id === from && c.to_id === to)) }
/** The document apart from its revision: what an undo restores. */
const definitions = (d: Doc) => ({ title: d.learningPath.title, goal: d.learningPath.goal, editor: d.editor, application: d.application })
/** Every stored row of one personal Path's editable content. */
async function personalRows(pathId = px.paths.main.id) {
  return {
    skills: (await db.select().from(personalSkills).where(eq(personalSkills.learningPathId, pathId))).map((r) => r.skillId).sort(),
    tasks: (await db.select().from(personalTasks).where(eq(personalTasks.learningPathId, pathId))).map((r) => r.taskId).sort(),
    cards: (await db.select().from(personalSkillCards).where(eq(personalSkillCards.learningPathId, pathId))).map((r) => r.skillId).sort(),
    edges: (await db.select().from(personalPrerequisites).where(eq(personalPrerequisites.learningPathId, pathId))).map((r) => `${r.prerequisiteSkillId}>${r.skillId}`).sort(),
  }
}
async function draftRows(versionId: string) {
  return {
    skills: (await db.select().from(versionSkills).where(eq(versionSkills.learningPathVersionId, versionId))).map((r) => r.skillId).sort(),
    tasks: (await db.select().from(versionTasks).where(eq(versionTasks.learningPathVersionId, versionId))).map((r) => r.taskId).sort(),
    cards: (await db.select().from(versionSkillCards).where(eq(versionSkillCards.learningPathVersionId, versionId))).map((r) => r.skillId).sort(),
    edges: (await db.select().from(versionPrerequisites).where(eq(versionPrerequisites.learningPathVersionId, versionId))).map((r) => `${r.prerequisiteSkillId}>${r.skillId}`).sort(),
  }
}

it('AC1/AC3: an unused personal Skill is deleted with its Tasks, card and connections, and an undo brings it back with the same IDs', async () => {
  const { skillA, skillB } = px.skills
  // Ownership has history; Lifetimes, its Task and the connection into it do not.
  await json(request(`${personal()}/tasks/${px.tasks.taskA.id}/completion`, 'learner', 'PUT'), 200)
  const stateBefore = (await json(request(`${personal()}/learning-state`, 'learner'), 200)).learningState
  // The learning state names the Skills a deletion would be refused for.
  expect(stateBefore.historySkillIds).toEqual([skillA.id])
  const doc: Doc = await json(request(personal(), 'learner'), 200)
  // A card position, so the undo restores a real arrangement rather than a default.
  const placed: Doc = await json(request(`${personal()}/document`, 'learner', 'PUT', edit(doc, (d) => { d.editor.cards.find((c) => c.id === skillB.id)!.position = { x: 610, y: 245 } })), 200)

  const deleted: Doc = await json(request(`${personal()}/document`, 'learner', 'PUT', edit(placed, withoutSkill(skillB.id))), 200)
  expect(deleted.learningPath.revision).toBe(placed.learningPath.revision + 1)
  expect(deleted.application.skills.map((s) => s.id)).toEqual([skillA.id])
  expect(deleted.editor).toEqual({ format_version: 1, cards: [placed.editor.cards.find((c) => c.id === skillA.id)!], connections: [] })
  // Nothing of it is left in the Path, and nothing refers to it: the learning state reads without it.
  expect(await personalRows()).toEqual({ skills: [skillA.id], tasks: [px.tasks.taskA.id, px.tasks.taskA2.id].sort(), cards: [skillA.id], edges: [] })
  const stateAfter = (await json(request(`${personal()}/learning-state`, 'learner'), 200)).learningState
  expect(stateAfter.skills.map((s: any) => s.skillId)).toEqual([skillA.id])
  expect(stateAfter.tasks.map((t: any) => t.taskId).sort()).toEqual([px.tasks.taskA.id, px.tasks.taskA2.id].sort())
  expect({ xp: stateAfter.xp, xpHistory: stateAfter.xpHistory }).toEqual({ xp: stateBefore.xp, xpHistory: stateBefore.xpHistory })
  // Its logical IDs stay this Path's: another Path cannot claim them.
  expect((await db.select().from(skills).where(eq(skills.id, skillB.id)))[0].learningPathId).toBe(px.paths.main.id)
  const other: Doc = await json(request(personal(px.paths.other.id), 'learner'), 200)
  const stolen = placed.application.skills.find((s) => s.id === skillB.id)!
  expect(await json(request(`${personal(px.paths.other.id)}/document`, 'learner', 'PUT', edit(other, (d) => {
    d.application.skills.push(stolen); d.editor.cards.push({ id: stolen.id, title: stolen.title, position: { x: 0, y: 0 } })
  })), 409)).toMatchObject({ error: 'skill_owned_elsewhere' })

  // The undo after the save: the same definitions, position and connection, sent as a new save.
  const restored: Doc = await json(request(`${personal()}/document`, 'learner', 'PUT', edit(deleted, (d) => {
    d.application.skills = structuredClone(placed.application.skills)
    d.editor = structuredClone(placed.editor)
  })), 200)
  expect(restored.learningPath.revision).toBe(deleted.learningPath.revision + 1)
  expect(definitions(restored)).toEqual(definitions(placed))
  expect(await personalRows()).toEqual({ skills: [skillA.id, skillB.id].sort(), tasks: [px.tasks.taskA.id, px.tasks.taskA2.id, px.tasks.taskB.id].sort(), cards: [skillA.id, skillB.id].sort(), edges: [`${skillA.id}>${skillB.id}`] })
  // Undo is an editor change: the completion, XP and Mastery history are what they were.
  const stateRestored = (await json(request(`${personal()}/learning-state`, 'learner'), 200)).learningState
  expect({ xp: stateRestored.xp, xpHistory: stateRestored.xpHistory, masteryHistory: stateRestored.masteryHistory }).toEqual({ xp: stateBefore.xp, xpHistory: stateBefore.xpHistory, masteryHistory: stateBefore.masteryHistory })
  expect(stateRestored.tasks.find((t: any) => t.taskId === px.tasks.taskA.id)).toMatchObject({ completed: true, xpContribution: 20 })

  // The redo deletes it again.
  const redone: Doc = await json(request(`${personal()}/document`, 'learner', 'PUT', edit(restored, withoutSkill(skillB.id))), 200)
  expect(definitions(redone)).toEqual(definitions(deleted))
})

it('AC1: removing a connection keeps both Skills; an unused Task leaves with its Skill only', async () => {
  const { skillA, skillB } = px.skills
  const doc: Doc = await json(request(personal(), 'learner'), 200)
  const disconnected: Doc = await json(request(`${personal()}/document`, 'learner', 'PUT', edit(doc, withoutConnection(skillA.id, skillB.id))), 200)
  expect(disconnected.editor.connections).toEqual([])
  expect((await personalRows()).skills).toEqual([skillA.id, skillB.id].sort())
  // Lifetimes no longer waits for Ownership.
  const state = (await json(request(`${personal()}/learning-state`, 'learner'), 200)).learningState
  expect(state.skills.find((s: any) => s.skillId === skillB.id).unmetPrerequisiteSkillIds).toEqual([])
  const reconnected: Doc = await json(request(`${personal()}/document`, 'learner', 'PUT', edit(disconnected, (d) => { d.editor.connections = doc.editor.connections })), 200)
  expect(definitions(reconnected)).toEqual(definitions(doc))
})

it('AC2: learning history refuses the deletion and changes nothing, even when it appeared after the deletion was made', async () => {
  const { skillA, skillB } = px.skills
  const doc: Doc = await json(request(personal(), 'learner'), 200)
  const before = await personalRows()
  // The owner deletes the unused Lifetimes, but opens it with an Access Override before the save
  // arrives: the override is a learning record that does not move the document revision.
  await json(request(`${personal()}/skills/${skillB.id}/access-override`, 'learner', 'PUT'), 200)
  expect((await json(request(personal(), 'learner'), 200)).learningPath.revision).toBe(doc.learningPath.revision)
  expect((await json(request(`${personal()}/learning-state`, 'learner'), 200)).learningState.historySkillIds).toEqual([skillB.id])
  expect(await json(request(`${personal()}/document`, 'learner', 'PUT', edit(doc, withoutSkill(skillB.id))), 409))
    .toMatchObject({ error: 'skill_has_history', detail: 'Skill "Lifetimes" has learning history and cannot be deleted; archive the Skill instead' })
  // A declared Mastery is history too.
  await json(request(`${personal()}/skills/${skillA.id}/mastery`, 'learner', 'PUT'), 200)
  expect(await json(request(`${personal()}/document`, 'learner', 'PUT', edit(doc, withoutSkill(skillA.id))), 409)).toMatchObject({ error: 'skill_has_history' })
  expect(await personalRows()).toEqual(before)
  expect(await json(request(personal(), 'learner'), 200)).toEqual(doc)
})

it('AC2/AC4: deletion follows the owner-only and revision rules; only the owner deletes, and a stale deletion changes nothing', async () => {
  const { skillB } = px.skills
  const doc: Doc = await json(request(personal(), 'learner'), 200)
  for (const actor of ['peer', 'coach', 'unrelated'] as const) expect((await request(`${personal()}/document`, actor, 'PUT', edit(doc, withoutSkill(skillB.id)))).status).toBe(404)
  expect((await request(`${personal()}/document`, null, 'PUT', edit(doc, withoutSkill(skillB.id)))).status).toBe(401)
  const renamed: Doc = await json(request(`${personal()}/document`, 'learner', 'PUT', edit(doc, (d) => { d.learningPath.goal = 'Saved in another tab' })), 200)
  const before = await personalRows()
  expect(await json(request(`${personal()}/document`, 'learner', 'PUT', edit(doc, withoutSkill(skillB.id))), 409)).toMatchObject({ error: 'stale_revision', current: renamed })
  expect(await personalRows()).toEqual(before)
  // A deletion that leaves a connection to the deleted Skill is refused as a whole.
  expect(await json(request(`${personal()}/document`, 'learner', 'PUT', edit(renamed, (d) => {
    d.application.skills = d.application.skills.filter((s) => s.id !== skillB.id); d.editor.cards = d.editor.cards.filter((c) => c.id !== skillB.id)
  })), 422)).toMatchObject({ error: 'connection_outside_path' })
  expect(await personalRows()).toEqual(before)
})

it('AC1-AC4: a Draft deletes content only it holds; published content is refused, earlier Versions stay, and a restoration breaking the Draft rules is refused', async () => {
  const enrollment = (await json(request(`/invitations/${fx.invitations.toLearner.id}/accept`, 'learner', 'POST'), 201)).enrollment.id
  const evidenceRoute = `/enrollments/${enrollment}/tasks/${fx.content.taskA.id}/submission`
  const sent = await json(request(`${evidenceRoute}/revisions`, 'learner', 'POST', { text: 'Vector evidence', urls: [] }), 201)
  await json(request(`${evidenceRoute}/revisions/${sent.revision.id}/review`, 'coach', 'POST', { decision: 'approval' }), 201)
  const progressBefore = (await json(request(`/enrollments/${enrollment}/learning-state`, 'learner'), 200)).learningState
  const evidenceBefore = (await json(request(evidenceRoute, 'learner'), 200)).submission
  const published = await json(request(coach(), 'coach'), 200)
  const draft: Doc = await json(request(`${coach()}/drafts`, 'coach', 'POST', { expectedRevision: published.learningPath.revision }), 201)
  const draftId = (await db.select({ id: versionSkills.learningPathVersionId }).from(versionSkills).where(eq(versionSkills.skillId, fx.content.skillA.id)))
    .map((r) => r.id).find((id) => id !== fx.versions.version1.id && id !== fx.versions.version2.id)!
  const version2 = await json(request(`/coach/learning-path-versions/${fx.versions.version2.id}`, 'coach'), 200)

  // A Draft-only Skill with a Task, connected from the published Vectors.
  const extra = { id: crypto.randomUUID(), task: crypto.randomUUID() }
  const added: Doc = await json(request(`${coach()}/draft`, 'coach', 'PUT', edit(draft, (d) => {
    d.application.skills.push({ id: extra.id, title: 'Eigenvalues', outcome: 'Find eigenvalues', optional: false, xpThreshold: 15, tasks: [{ id: extra.task, title: 'Eigen drills', description: 'Ten drills', required: true, xpReward: 25 }] })
    d.editor.cards.push({ id: extra.id, title: 'Eigenvalues', position: { x: 700, y: 300 } })
    d.editor.connections.push({ from_id: fx.content.skillA.id, to_id: extra.id })
  })), 200)
  const rowsWithExtra = await draftRows(draftId)

  // Published content is history: it is refused, never deleted in place.
  expect(await json(request(`${coach()}/draft`, 'coach', 'PUT', edit(added, withoutSkill(fx.content.skillB.id))), 409)).toMatchObject({ error: 'skill_has_history' })
  expect(await draftRows(draftId)).toEqual(rowsWithExtra)
  // Only the owning Coach deletes.
  for (const actor of ['learner', 'otherCoach', 'peer'] as const) expect((await request(`${coach()}/draft`, actor, 'PUT', edit(added, withoutSkill(extra.id)))).status).toBe(404)

  const deleted: Doc = await json(request(`${coach()}/draft`, 'coach', 'PUT', edit(added, withoutSkill(extra.id))), 200)
  expect(definitions(deleted)).toEqual(definitions(draft))
  expect(await draftRows(draftId)).toEqual(await (async () => { const r = structuredClone(rowsWithExtra); return {
    skills: r.skills.filter((id) => id !== extra.id), tasks: r.tasks.filter((id) => id !== extra.task), cards: r.cards.filter((id) => id !== extra.id), edges: r.edges.filter((e) => !e.includes(extra.id)),
  } })())
  expect(await db.select().from(tasks).where(inArray(tasks.id, [extra.task]))).toHaveLength(1)

  // Undo after the save: the same definitions, rules and rewards, as a new save.
  const restored: Doc = await json(request(`${coach()}/draft`, 'coach', 'PUT', edit(deleted, (d) => { d.application = structuredClone(added.application); d.editor = structuredClone(added.editor) })), 200)
  expect(definitions(restored)).toEqual(definitions(added))
  expect(await draftRows(draftId)).toEqual(rowsWithExtra)

  // A connection removed, then its Prerequisite made Optional: bringing the connection back now breaks the
  // Draft rules (an Optional Skill cannot be a Prerequisite of a required one) and is refused, changing nothing.
  const disconnected: Doc = await json(request(`${coach()}/draft`, 'coach', 'PUT', edit(restored, withoutConnection(fx.content.skillA.id, extra.id))), 200)
  const optional: Doc = await json(request(`${coach()}/draft`, 'coach', 'PUT', edit(disconnected, (d) => { d.application.skills.find((s) => s.id === fx.content.skillA.id)!.optional = true; d.editor.connections = d.editor.connections.filter((c) => c.from_id !== fx.content.skillA.id) })), 200)
  expect(await json(request(`${coach()}/draft`, 'coach', 'PUT', edit(optional, (d) => { d.editor.connections.push({ from_id: fx.content.skillA.id, to_id: extra.id }) })), 422)).toMatchObject({ error: 'optional_prerequisite' })
  expect(await json(request(coach(), 'coach'), 200)).toEqual(optional)

  // The published Versions, pinned Enrollment and immutable assessment records never changed.
  expect((await json(request(`/coach/learning-path-versions/${fx.versions.version2.id}`, 'coach'), 200)).application).toEqual(version2.application)
  expect((await json(request(`/enrollments/${enrollment}/learning-state`, 'learner'), 200)).learningState).toEqual(progressBefore)
  expect((await json(request(evidenceRoute, 'learner'), 200)).submission).toEqual(evidenceBefore)
})
