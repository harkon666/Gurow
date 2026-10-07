import { afterAll, beforeAll, beforeEach, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { createApp } from '../src/app'
import type { Database } from '../src/db/client'
import { enrollmentInvitations, versionTasks } from '../src/db/schema'
import { FIXTURE_IDENTITY_HEADER, fixtureIdentity } from '../src/identity'
import { prepareTestDatabase, resetTestDatabase } from './support/database'
import { amendPublished, seedEnrollmentFixture, seedPersonalFixture, type EnrollmentFixture, type PersonalFixture } from './support/fixtures'

/**
 * T29 (#30): reusing Skills and Tasks as independent copies (ADR 0004) through the
 * request boundary on PostgreSQL. A copy is read from a source the author may read
 * and reaches its destination as an ordinary save with new logical IDs, so the
 * backend's rules decide it: source IDs, cross-Path Prerequisites and writes into
 * published content are refused, and no learning record follows a copy.
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

interface Task { id: string; title: string; description: string; required?: boolean; xpReward?: number }
interface Skill { id: string; title: string; outcome: string; optional?: boolean; xpThreshold?: number; tasks: Task[] }
interface Doc {
  learningPath: { id: string; title: string; goal: string; revision: number }
  editor: { format_version: 1; cards: { id: string; title: string; position: { x: number; y: number } }[]; connections: { from_id: string; to_id: string }[] }
  application: { skills: Skill[] }
}
const personalPath = (pathId: string) => `/personal/learning-paths/${pathId}`
const coachPath = (pathId: string) => `/coach/learning-paths/${pathId}`
const savePersonal = (pathId: string, body: unknown, actor: Actor = 'learner') => request(`${personalPath(pathId)}/document`, actor, 'PUT', body)
const saveDraft = (pathId: string, body: unknown, actor: Actor = 'coach') => request(`${coachPath(pathId)}/draft`, actor, 'PUT', body)
const edit = (doc: Doc, change: (d: Doc) => void) => {
  const next = structuredClone(doc)
  change(next)
  return { expectedRevision: doc.learningPath.revision, title: next.learningPath.title, goal: next.learningPath.goal, editor: next.editor, application: next.application }
}

/**
 * Copies Skills of `source` into `d` the way the editor does: new logical IDs for each
 * Skill and Task, only the Prerequisites among the copied Skills, and the Draft rules
 * only between Drafts. Returns the new Skill ID of each copied source Skill.
 */
function copySkills(d: Doc, source: Doc, skillIds: string[], rules: 'keep' | 'drop' | 'default' = 'drop') {
  const ids = new Map(skillIds.map((id) => [id, crypto.randomUUID()]))
  for (const id of skillIds) {
    const skill = source.application.skills.find((s) => s.id === id)!
    const card = source.editor.cards.find((c) => c.id === id)!
    const ruled = (task: Task): Task => rules === 'keep' ? { ...task, id: crypto.randomUUID() }
      : rules === 'default' ? { id: crypto.randomUUID(), title: task.title, description: task.description, required: true, xpReward: 0 }
      : { id: crypto.randomUUID(), title: task.title, description: task.description }
    d.application.skills.push({
      id: ids.get(id)!, title: skill.title, outcome: skill.outcome, tasks: skill.tasks.map(ruled),
      ...(rules === 'keep' ? { optional: skill.optional, xpThreshold: skill.xpThreshold } : rules === 'default' ? { optional: false, xpThreshold: 0 } : {}),
    })
    d.editor.cards.push({ id: ids.get(id)!, title: skill.title, position: { x: card.position.x + 1000, y: card.position.y } })
  }
  for (const edge of source.editor.connections) {
    if (ids.has(edge.from_id) && ids.has(edge.to_id)) d.editor.connections.push({ from_id: ids.get(edge.from_id)!, to_id: ids.get(edge.to_id)! })
  }
  return ids
}

async function personalState(pathId: string, actor: Actor = 'learner') {
  return (await json(request(`${personalPath(pathId)}/learning-state`, actor), 200)).learningState
}
async function enrollmentState(enrollmentId: string, actor: Actor = 'learner') {
  return (await json(request(`/enrollments/${enrollmentId}/learning-state`, actor), 200)).learningState
}

it('AC4: the sources an Account may copy from are its own Paths, Drafts and Versions only', async () => {
  const learner = await json(request('/reuse/sources', 'learner'), 200)
  expect(learner.personal.map((p: any) => p.title).sort()).toEqual(['Personal Guitar', 'Personal Rust'])
  expect(learner.coach).toEqual([])

  // An Enrollment is no source: the learner's Version stays the Coach's content.
  await json(request(`/invitations/${fx.invitations.toLearner.id}/accept`, 'learner', 'POST'), 201)
  expect((await json(request('/reuse/sources', 'learner'), 200)).coach).toEqual([])
  expect((await request(`/coach/learning-path-versions/${fx.versions.version1.id}`, 'learner')).status).toBe(404)
  expect((await request(coachPath(fx.paths.path.id), 'learner')).status).toBe(404)

  const coach = await json(request('/reuse/sources', 'coach'), 200)
  expect(coach.personal).toEqual([])
  // The fixture's two Paths are created together, so their order is by ID only.
  const byTitle = (paths: any[]) => [...paths].sort((a, b) => a.title.localeCompare(b.title))
  expect(coach.coach).toHaveLength(1)
  expect(coach.coach[0].workspace).toEqual({ id: fx.workspaces.workspace.id, name: 'Linear Algebra with Coach' })
  expect(byTitle(coach.coach[0].learningPaths)).toEqual([
    { learningPathId: fx.paths.siblingPath.id, title: 'Calculus', draft: null, versions: [{ id: fx.versions.siblingVersion.id, versionNumber: 1 }, { id: fx.versions.closedVersion.id, versionNumber: 2 }] },
    { learningPathId: fx.paths.path.id, title: 'Linear Algebra', draft: null, versions: [{ id: fx.versions.version1.id, versionNumber: 1 }, { id: fx.versions.version2.id, versionNumber: 2 }] },
  ])

  // Another Coach sees only their own Workspace; the peer only their own Path; nobody anonymous.
  expect(await json(request('/reuse/sources', 'otherCoach'), 200)).toEqual({ personal: [], coach: [{ workspace: { id: fx.workspaces.otherWorkspace.id, name: 'Another Coach' }, learningPaths: [] }] })
  expect((await json(request('/reuse/sources', 'peer'), 200)).personal).toEqual([{ learningPathId: px.paths.peers.id, title: 'Peer Notes' }])
  expect((await request('/reuse/sources', null)).status).toBe(401)

  // An open Draft is listed as a source beside the published Versions.
  const sibling = await json(request(coachPath(fx.paths.siblingPath.id), 'coach'), 200)
  const prepared = await json(request(`${coachPath(fx.paths.siblingPath.id)}/drafts`, 'coach', 'POST', { expectedRevision: sibling.learningPath.revision }), 201)
  const listed = (await json(request('/reuse/sources', 'coach'), 200)).coach[0].learningPaths.find((p: any) => p.title === 'Calculus')
  expect(listed.draft).toEqual({ id: prepared.draft.id, versionNumber: 3 })
})

it('AC1/AC2/AC3: a personal copy gets new IDs, keeps only Prerequisites inside the copied set and inherits no records', async () => {
  // The source has records: a completed 20-XP Task and declared Mastery of Ownership.
  await json(request(`${personalPath(px.paths.main.id)}/tasks/${px.tasks.taskA.id}/completion`, 'learner', 'PUT'), 200)
  await json(request(`${personalPath(px.paths.main.id)}/skills/${px.skills.skillA.id}/mastery`, 'learner', 'PUT'), 200)
  const sourceBefore: Doc = await json(request(personalPath(px.paths.main.id), 'learner'), 200)
  const sourceState = await personalState(px.paths.main.id)
  expect(sourceState.xp).toBe(20)

  // Reusing a source ID is not a copy: the IDs belong to the source Path, and the save changes nothing.
  const guitar: Doc = await json(request(personalPath(px.paths.other.id), 'learner'), 200)
  const sameSkill = edit(guitar, (d) => {
    const ownership = sourceBefore.application.skills[0]
    d.application.skills.push({ ...ownership, tasks: [] })
    d.editor.cards.push({ ...sourceBefore.editor.cards[0] })
  })
  expect(await json(savePersonal(px.paths.other.id, sameSkill), 409)).toMatchObject({ error: 'skill_owned_elsewhere' })
  const sameTask = edit(guitar, (d) => {
    const id = crypto.randomUUID()
    d.application.skills.push({ id, title: 'Ownership', outcome: '', tasks: [{ ...sourceBefore.application.skills[0].tasks[0] }] })
    d.editor.cards.push({ id, title: 'Ownership', position: { x: 0, y: 0 } })
  })
  expect(await json(savePersonal(px.paths.other.id, sameTask), 409)).toMatchObject({ error: 'task_owned_elsewhere' })
  // A Prerequisite on a Skill of another Path cannot be carried across.
  const crossPath = edit(guitar, (d) => {
    const ids = copySkills(d, sourceBefore, [px.skills.skillB.id])
    d.editor.connections.push({ from_id: px.skills.skillA.id, to_id: ids.get(px.skills.skillB.id)! })
  })
  expect(await json(savePersonal(px.paths.other.id, crossPath), 422)).toMatchObject({ error: 'connection_outside_path' })
  expect(await json(request(personalPath(px.paths.other.id), 'learner'), 200)).toEqual(guitar)

  // Copying both Skills keeps their Prerequisite; copying Lifetimes alone drops it.
  let ids!: Map<string, string>
  const copied: Doc = await json(savePersonal(px.paths.other.id, edit(guitar, (d) => { ids = copySkills(d, sourceBefore, [px.skills.skillA.id, px.skills.skillB.id]) })), 200)
  const ownershipCopy = ids.get(px.skills.skillA.id)!, lifetimesCopy = ids.get(px.skills.skillB.id)!
  expect(copied.application.skills.map((s) => s.title)).toEqual(['Chords', 'Ownership', 'Lifetimes'])
  expect(copied.editor.connections).toEqual([{ from_id: ownershipCopy, to_id: lifetimesCopy }])
  const sourceIds = new Set([...sourceBefore.application.skills.map((s) => s.id), ...sourceBefore.application.skills.flatMap((s) => s.tasks.map((t) => t.id))])
  const copyIds = copied.application.skills.slice(1).flatMap((s) => [s.id, ...s.tasks.map((t) => t.id)])
  expect(copyIds).toHaveLength(5)
  expect(copyIds.filter((id) => sourceIds.has(id))).toEqual([])
  expect(copied.application.skills[1].tasks.map((t) => t.title).sort()).toEqual(['Borrow checker exercises', 'Read the ownership chapter'])

  const again = await json(request(personalPath(px.paths.other.id), 'learner'), 200)
  const single: Doc = await json(savePersonal(px.paths.other.id, edit(again, (d) => { copySkills(d, sourceBefore, [px.skills.skillB.id]) })), 200)
  expect(single.editor.connections).toEqual([{ from_id: ownershipCopy, to_id: lifetimesCopy }])
  expect(single.application.skills).toHaveLength(4)

  // No completion, reward, threshold or Mastery follows the copy.
  const copyState = await personalState(px.paths.other.id)
  expect(copyState.xp).toBe(0)
  expect(copyState.skills.find((s: any) => s.skillId === ownershipCopy)).toMatchObject({ mastery: false, xpThreshold: 0 })
  expect(copyState.skills.find((s: any) => s.skillId === lifetimesCopy)).toMatchObject({ mastery: false, xpThreshold: 0, unmetPrerequisiteSkillIds: [ownershipCopy] })
  for (const task of copyState.tasks.filter((t: any) => t.skillId !== px.skills.otherSkill.id)) expect(task).toMatchObject({ completed: false, xpReward: 0, xpContribution: 0 })
  expect(copyState.xpHistory).toEqual([])
  expect(copyState.masteryHistory).toEqual([])
  // A source Task's records are not reachable through the copy's Path.
  expect((await request(`${personalPath(px.paths.other.id)}/tasks/${px.tasks.taskA.id}/completion`, 'learner', 'PUT')).status).toBe(404)

  // Editing the copy leaves the source as it was.
  const latest: Doc = await json(request(personalPath(px.paths.other.id), 'learner'), 200)
  await json(savePersonal(px.paths.other.id, edit(latest, (d) => {
    const copy = d.application.skills.find((s) => s.id === ownershipCopy)!
    copy.outcome = 'Explain moves in my own words'
    copy.tasks[0].title = 'Borrow checker kata'
  })), 200)
  expect(await json(request(personalPath(px.paths.main.id), 'learner'), 200)).toEqual(sourceBefore)
  expect(await personalState(px.paths.main.id)).toEqual(sourceState)
})

it('AC4: copies are written only where the author may write, never into another Account\'s Path', async () => {
  const source: Doc = await json(request(personalPath(px.paths.main.id), 'learner'), 200)
  const peers: Doc = await json(request(personalPath(px.paths.peers.id), 'peer'), 200)
  // The peer can neither read the learner's Path nor write a copy into it; the learner cannot write into the peer's.
  for (const actor of ['peer', 'coach', 'unrelated'] as const) expect((await request(personalPath(px.paths.main.id), actor)).status).toBe(404)
  expect((await savePersonal(px.paths.peers.id, edit(peers, (d) => { copySkills(d, source, [px.skills.skillA.id]) }), 'learner')).status).toBe(404)
  const main = edit(source, (d) => { copySkills(d, peers, [px.skills.peerSkill.id]) })
  expect((await savePersonal(px.paths.main.id, main, 'peer')).status).toBe(404)
  expect(await json(request(personalPath(px.paths.peers.id), 'peer'), 200)).toEqual(peers)
  // Coach content is written into a Draft only by its Workspace's owner.
  const sibling = await json(request(coachPath(fx.paths.siblingPath.id), 'coach'), 200)
  await json(request(`${coachPath(fx.paths.siblingPath.id)}/drafts`, 'coach', 'POST', { expectedRevision: sibling.learningPath.revision }), 201)
  const draft = await json(request(coachPath(fx.paths.siblingPath.id), 'coach'), 200)
  for (const actor of ['otherCoach', 'learner'] as const) {
    expect((await saveDraft(fx.paths.siblingPath.id, edit(draft, (d) => { copySkills(d, source, [px.skills.skillA.id], 'default') }), actor)).status).toBe(404)
  }
  expect(await json(request(coachPath(fx.paths.siblingPath.id), 'coach'), 200)).toEqual(draft)
})

it('AC1/AC2/AC4: a Coach copies published content into a Draft only, and the copy inherits no Enrollment progress', async () => {
  // Version 1's Task A is worth 20 XP; the learner earns it and Mastery of Vectors.
  await amendPublished(db, (tx) => tx.update(versionTasks).set({ xpReward: 20 }).where(eq(versionTasks.learningPathVersionId, fx.versions.version1.id)))
  const enrollment = (await json(request(`/invitations/${fx.invitations.toLearner.id}/accept`, 'learner', 'POST'), 201)).enrollment.id
  const submission = (task: string, id = enrollment) => `/enrollments/${id}/tasks/${task}/submission`
  const sent = await json(request(`${submission(fx.content.taskA.id)}/revisions`, 'learner', 'POST', { text: 'Vector evidence', urls: [] }), 201)
  await json(request(`${submission(fx.content.taskA.id)}/revisions/${sent.revision.id}/review`, 'coach', 'POST', { decision: 'approval' }), 201)
  const sourceProgress = await enrollmentState(enrollment)
  expect(sourceProgress.xp).toBe(20)
  expect(sourceProgress.skills.find((s: any) => s.skillId === fx.content.skillA.id).mastery).toBe(true)
  const version1 = await json(request(`/coach/learning-path-versions/${fx.versions.version1.id}`, 'coach'), 200)

  // Calculus has no open Draft: its published Versions cannot take the copy.
  const calculus = await json(request(coachPath(fx.paths.siblingPath.id), 'coach'), 200)
  const published = await json(request(`/coach/learning-path-versions/${fx.versions.closedVersion.id}`, 'coach'), 200)
  expect(await json(saveDraft(fx.paths.siblingPath.id, edit(calculus, (d) => { copySkills(d, version1, [fx.content.skillA.id], 'keep') })), 409)).toMatchObject({ error: 'no_open_draft' })
  expect(await json(request(`/coach/learning-path-versions/${fx.versions.closedVersion.id}`, 'coach'), 200)).toEqual(published)

  // In a Draft, the copy keeps the Draft rules and gets new IDs; the source IDs are refused.
  const prepared = await json(request(`${coachPath(fx.paths.siblingPath.id)}/drafts`, 'coach', 'POST', { expectedRevision: calculus.learningPath.revision }), 201)
  expect(await json(saveDraft(fx.paths.siblingPath.id, edit(prepared, (d) => {
    const vectors = version1.application.skills[0]
    d.application.skills.push({ ...vectors, tasks: [] })
    d.editor.cards.push({ ...version1.editor.cards[0] })
  })), 409)).toMatchObject({ error: 'skill_owned_elsewhere' })
  let ids!: Map<string, string>
  const copied = await json(saveDraft(fx.paths.siblingPath.id, edit(prepared, (d) => { ids = copySkills(d, version1, [fx.content.skillA.id], 'keep') })), 200)
  const vectorsCopy = copied.application.skills.find((s: Skill) => s.id === ids.get(fx.content.skillA.id))
  expect(vectorsCopy.tasks.map((t: Task) => [t.title, t.required, t.xpReward]).sort()).toEqual([['Read chapter 1', false, 20], ['Vector exercises', true, 20]])
  expect(vectorsCopy.tasks.map((t: Task) => t.id)).not.toContain(fx.content.taskA.id)

  // Editing the copy changes neither the source Version nor the learner's records there.
  const renamed = await json(saveDraft(fx.paths.siblingPath.id, edit(copied, (d) => {
    const copy = d.application.skills.find((s) => s.id === ids.get(fx.content.skillA.id))!
    copy.tasks[0].title = 'Vector drills'
    copy.tasks[1].xpReward = 0
  })), 200)
  expect(await json(request(`/coach/learning-path-versions/${fx.versions.version1.id}`, 'coach'), 200)).toEqual(version1)

  // Published, the copy is a separate learning contract: the same learner starts it with nothing.
  const v3 = await json(request(`${coachPath(fx.paths.siblingPath.id)}/publication`, 'coach', 'POST', { expectedRevision: renamed.learningPath.revision }), 200)
  const [invitation] = await db.insert(enrollmentInvitations).values({ learningPathVersionId: v3.version.id, email: 'learner@gurow.test', invitedByAccountId: fx.accounts.coach.id }).returning()
  const copyEnrollment = (await json(request(`/invitations/${invitation.id}/accept`, 'learner', 'POST'), 201)).enrollment.id
  const copyProgress = await enrollmentState(copyEnrollment)
  expect(copyProgress.xp).toBe(0)
  expect(copyProgress.skills.find((s: any) => s.skillId === ids.get(fx.content.skillA.id))).toMatchObject({ mastery: false })
  expect(copyProgress.tasks.every((t: any) => !t.approved && t.xpContribution === 0)).toBe(true)
  expect(copyProgress.reviewHistory ?? []).toEqual([])
  const copiedTask = vectorsCopy.tasks[0].id
  expect(await json(request(submission(copiedTask, copyEnrollment), 'learner'), 404)).toMatchObject({ error: 'submission_not_found' })
  // The source Task is not part of the copy's Version, so its Submission does not follow.
  expect(await json(request(submission(fx.content.taskA.id, copyEnrollment), 'learner'), 404)).toMatchObject({ error: 'task_not_found' })
  expect(await enrollmentState(enrollment)).toEqual(sourceProgress)
})

it('AC1/AC2: Coach content copied into the Coach\'s own personal Path drops the Draft rules and stays independent', async () => {
  const draftSource = await json(request(coachPath(fx.paths.path.id), 'coach'), 200)
  const prepared = await json(request(`${coachPath(fx.paths.path.id)}/drafts`, 'coach', 'POST', { expectedRevision: draftSource.learningPath.revision }), 201)
  const personal: Doc = await json(request('/personal/learning-paths', 'coach', 'POST', { title: 'My own algebra', goal: '' }), 201)
  let ids!: Map<string, string>
  const copied: Doc = await json(savePersonal(personal.learningPath.id, edit(personal, (d) => { ids = copySkills(d, prepared, [fx.content.skillB.id]) }), 'coach'), 200)
  expect(copied.application.skills).toEqual([{ id: ids.get(fx.content.skillB.id)!, title: 'Matrices (revised)', outcome: 'Multiply matrices and interpret them as linear maps', tasks: [{ id: expect.any(String), title: 'Matrix exercises (revised)', description: '' }] }])
  // The source Draft can still change on its own; the copy keeps what it had.
  const changed = await json(saveDraft(fx.paths.path.id, edit(prepared, (d) => { d.application.skills[1].outcome = 'Changed in the Draft' })), 200)
  expect(changed.application.skills[1].outcome).toBe('Changed in the Draft')
  expect(await json(request(personalPath(personal.learningPath.id), 'coach'), 200)).toEqual(copied)
  // The Coach's personal Path is no source for anyone else.
  expect((await json(request('/reuse/sources', 'coach'), 200)).personal).toEqual([{ learningPathId: personal.learningPath.id, title: 'My own algebra' }])
  expect((await json(request('/reuse/sources', 'learner'), 200)).personal.map((p: any) => p.title)).not.toContain('My own algebra')
})
