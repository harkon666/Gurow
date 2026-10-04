import { afterAll, beforeAll, beforeEach, expect, it } from 'bun:test'
import { createApp } from '../src/app'
import type { Database } from '../src/db/client'
import { FIXTURE_IDENTITY_HEADER, fixtureIdentity } from '../src/identity'
import { prepareTestDatabase, resetTestDatabase } from './support/database'
import { seedEnrollmentFixture, seedPersonalFixture, type EnrollmentFixture, type PersonalFixture } from './support/fixtures'

/**
 * T17 (#18): personal tracking on Paths authored through the document API, the way
 * the browser creates them. Covers the XP Threshold rule the UI configures, and the
 * separation of learning actions from the document revision.
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
async function request(path: string, actor: Actor = 'learner', method = 'GET', body?: unknown) {
  return app.request(path, { method, headers: { ...(actor ? { [FIXTURE_IDENTITY_HEADER]: actor } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
}
async function json(response: Response | Promise<Response>, status: number) {
  const r = await response
  const body = await r.json() as any
  expect({ status: r.status, body }).toMatchObject({ status })
  return body
}

/** A Path created and saved through the document API: A → B, each Skill with one Task. */
async function authoredPath(title: string, actor: Actor = 'learner') {
  const created = await json(request('/personal/learning-paths', actor, 'POST', { title, goal: `${title} goal` }), 201)
  const [a, b, taskA, taskB] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]
  const doc = await json(request(`/personal/learning-paths/${created.learningPath.id}/document`, actor, 'PUT', {
    expectedRevision: 0, title, goal: `${title} goal`,
    editor: { format_version: 1, cards: [{ id: a, title: 'Ownership', position: { x: 80, y: 100 } }, { id: b, title: 'Lifetimes', position: { x: 360, y: 100 } }], connections: [{ from_id: a, to_id: b }] },
    application: { skills: [
      { id: a, title: 'Ownership', outcome: 'Explain moves', tasks: [{ id: taskA, title: 'Borrow exercises', description: '' }] },
      { id: b, title: 'Lifetimes', outcome: 'Annotate signatures', tasks: [{ id: taskB, title: 'Annotate a parser', description: '' }] },
    ] },
  }), 200)
  return { pathId: created.learningPath.id as string, revision: doc.learningPath.revision as number, a, b, taskA, taskB }
}
type Authored = Awaited<ReturnType<typeof authoredPath>>

const at = (p: Authored) => `/personal/learning-paths/${p.pathId}`
const act = async (p: Authored, path: string, method: string, body?: unknown, changed = true, actor: Actor = 'learner') => {
  const result = await json(request(`${at(p)}${path}`, actor, method, body), 200)
  expect(result.changed).toBe(changed)
  return result.learningState
}
const threshold = (p: Authored, skill: string, xpThreshold: unknown, actor: Actor = 'learner') => request(`${at(p)}/skills/${skill}/xp-threshold`, actor, 'PUT', { xpThreshold })
const learningState = async (p: Authored, actor: Actor = 'learner') => (await json(request(`${at(p)}/learning-state`, actor), 200)).learningState
const skill = (s: any, id: string) => s.skills.find((x: any) => x.skillId === id)
const task = (s: any, id: string) => s.tasks.find((x: any) => x.taskId === id)
const revision = async (p: Authored) => (await json(request(at(p)), 200)).learningPath.revision

it('AC1/AC3: an authored Path tracks its own Tasks; new Tasks start at reward 0, incomplete, and contribute nothing', async () => {
  const p = await authoredPath('Systems Rust')
  let s = await learningState(p)
  expect(s.xp).toBe(0)
  expect(s.tasks.map((t: any) => [t.taskId, t.skillId, t.xpReward, t.completed, t.xpContribution]).sort()).toEqual([
    [p.taskA, p.a, 0, false, 0], [p.taskB, p.b, 0, false, 0],
  ].sort())
  // Locked Skills keep their title and outcome in the learning state, with the reason.
  expect(skill(s, p.b)).toMatchObject({ title: 'Lifetimes', learningOutcome: 'Annotate signatures', access: false, unmetPrerequisiteSkillIds: [p.a], xpShortfall: 0, mastery: false })
  // The 20-to-50 example on an authored Task: award, +30 correction, undo −50, completion again +50.
  s = await act(p, `/tasks/${p.taskA}/reward`, 'PUT', { xpReward: 20 })
  expect(task(s, p.taskA)).toMatchObject({ xpReward: 20, xpContribution: 0 })
  expect(s.xpHistory).toEqual([])
  s = await act(p, `/tasks/${p.taskA}/completion`, 'PUT')
  s = await act(p, `/tasks/${p.taskA}/reward`, 'PUT', { xpReward: 50 })
  s = await act(p, `/tasks/${p.taskA}/completion`, 'DELETE')
  s = await act(p, `/tasks/${p.taskA}/completion`, 'PUT')
  expect(s.xpHistory.map((e: any) => [e.kind, e.cause, e.amount])).toEqual([
    ['award', 'completion', 20], ['correction', 'reward_change', 30], ['correction', 'completion_undone', -50], ['correction', 'completion', 50],
  ])
  expect(s.xp).toBe(50)
  // Completion never declared Mastery.
  expect(skill(s, p.a).mastery).toBe(false)
  expect(s.masteryHistory).toEqual([])
})

it('AC4: the XP Threshold is an owner rule; raising it relocks started work and keeps work, XP and Mastery', async () => {
  const p = await authoredPath('Systems Rust')
  await act(p, `/tasks/${p.taskA}/reward`, 'PUT', { xpReward: 20 })
  await act(p, `/tasks/${p.taskA}/completion`, 'PUT')
  await act(p, `/skills/${p.a}/mastery`, 'PUT')
  let s = await act(p, `/tasks/${p.taskB}/completion`, 'PUT')
  await act(p, `/skills/${p.b}/mastery`, 'PUT')
  expect(skill(s, p.b)).toMatchObject({ access: true, xpThreshold: 0 })
  const before = await learningState(p)

  // A threshold met by Path XP keeps Access and spends nothing.
  s = await json(threshold(p, p.b, 20), 200).then((r) => r.learningState)
  expect(skill(s, p.b)).toMatchObject({ access: true, xpThreshold: 20, xpShortfall: 0 })
  expect(s.xp).toBe(20)
  // Raising it above Path XP relocks B, whose Task is completed and Mastery declared.
  s = (await json(threshold(p, p.b, 35), 200)).learningState
  // The rule belongs to B alone: A keeps no threshold and its Access.
  expect(skill(s, p.a)).toMatchObject({ xpThreshold: 0, access: true })
  expect(skill(s, p.b)).toMatchObject({ access: false, xpThreshold: 35, xpShortfall: 15, unmetPrerequisiteSkillIds: [], mastery: true })
  expect(task(s, p.taskB)).toMatchObject({ completed: true })
  expect(s.xp).toBe(before.xp)
  expect(s.xpHistory).toEqual(before.xpHistory)
  expect(s.masteryHistory).toEqual(before.masteryHistory)
  expect(s.overrideHistory).toEqual([])
  // Repeating it records nothing.
  expect((await json(threshold(p, p.b, 35), 200)).changed).toBe(false)
  // While locked, undoing B's completion is a correction and allowed; completing it again is refused.
  s = await act(p, `/tasks/${p.taskB}/completion`, 'DELETE')
  expect(await json(request(`${at(p)}/tasks/${p.taskB}/completion`, 'learner', 'PUT'), 403)).toEqual({ error: 'skill_locked' })
  expect(skill(s, p.b).mastery).toBe(true)
  // Lowering it again restores Access under the ordinary rules.
  s = (await json(threshold(p, p.b, 0), 200)).learningState
  expect(skill(s, p.b)).toMatchObject({ access: true, xpShortfall: 0 })
})

it('AC4: Access in one Path uses only that Path\'s XP; learning actions never change the document revision', async () => {
  const rust = await authoredPath('Systems Rust')
  const guitar = await authoredPath('Jazz Guitar')
  await act(guitar, `/tasks/${guitar.taskA}/reward`, 'PUT', { xpReward: 500 })
  const g = await act(guitar, `/tasks/${guitar.taskA}/completion`, 'PUT')
  expect(g.xp).toBe(500)
  await act(rust, `/skills/${rust.a}/mastery`, 'PUT')
  let s = (await json(threshold(rust, rust.b, 100), 200)).learningState
  expect(s.xp).toBe(0)
  expect(skill(s, rust.b)).toMatchObject({ access: false, xpShortfall: 100 })
  // The fixture Paths of the same Account do not count either.
  await act({ ...rust, pathId: px.paths.other.id }, `/tasks/${px.tasks.otherTask.id}/completion`, 'PUT')
  expect(skill(await learningState(rust), rust.b)).toMatchObject({ access: false, xpShortfall: 100 })
  // An explicit override without a reason opens B; XP, Mastery and histories stay.
  s = await act(rust, `/skills/${rust.b}/access-override`, 'PUT')
  expect(skill(s, rust.b)).toMatchObject({ access: true, xpShortfall: 100, mastery: false })
  expect(s.xp).toBe(0)
  expect(s.overrideHistory.map((r: any) => r.action)).toEqual(['grant'])
  expect((await learningState(guitar)).xp).toBe(500)
  // None of these learning actions made an open editor stale.
  expect(await revision(rust)).toBe(rust.revision)
  expect(await revision(guitar)).toBe(guitar.revision)
})

it('AC2/AC6: thresholds are owner-only and validated; refused requests change nothing', async () => {
  const p = await authoredPath('Systems Rust')
  const before = await learningState(p)
  for (const value of [-1, 1.5, '20', null, 1_000_000_001]) expect(await json(threshold(p, p.b, value), 422)).toEqual({ error: 'invalid_threshold' })
  for (const actor of ['peer', 'coach', 'otherCoach', 'unrelated', 'unverified'] as const) {
    expect(await json(threshold(p, p.b, 10, actor), 404)).toEqual({ error: 'learning_path_not_found' })
  }
  expect((await threshold(p, p.b, 10, null)).status).toBe(401)
  // A Skill of another Path, a Task ID and a malformed ID are not Skills of this Path.
  for (const target of [px.skills.skillB.id, p.taskA, 'not-a-uuid']) expect(await json(threshold(p, target, 10), 404)).toEqual({ error: 'skill_not_found' })
  expect(await learningState(p)).toEqual(before)
  expect(await revision(p)).toBe(p.revision)
})
