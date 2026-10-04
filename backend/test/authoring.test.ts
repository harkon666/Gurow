import { afterAll, beforeAll, beforeEach, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { createApp } from '../src/app'
import type { Database } from '../src/db/client'
import { learningPaths, personalPrerequisites, personalSkillCards, personalSkills, personalTasks, skills, tasks } from '../src/db/schema'
import { FIXTURE_IDENTITY_HEADER, fixtureIdentity } from '../src/identity'
import { prepareTestDatabase, resetTestDatabase } from './support/database'
import { seedEnrollmentFixture, seedPersonalFixture, type EnrollmentFixture, type PersonalFixture } from './support/fixtures'

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

interface Doc {
  learningPath: { id: string; title: string; goal: string; revision: number; personalWorkspaceId: string }
  editor: { format_version: 1; cards: { id: string; title: string; position: { x: number; y: number } }[]; connections: { from_id: string; to_id: string }[] }
  application: { skills: { id: string; title: string; outcome: string; tasks: { id: string; title: string; description: string }[] }[] }
}
const createPath = (title: string, goal: string, actor: Actor = 'learner') => request('/personal/learning-paths', actor, 'POST', { title, goal })
const read = (pathId: string, actor: Actor = 'learner') => request(`/personal/learning-paths/${pathId}`, actor)
const save = (pathId: string, body: unknown, actor: Actor = 'learner') => request(`/personal/learning-paths/${pathId}/document`, actor, 'PUT', body)
/** The edit a client sends: the document it holds, based on the revision it last saw. */
const edit = (doc: Doc, change: (d: Doc) => void = () => {}) => {
  const next = structuredClone(doc)
  change(next)
  return { expectedRevision: doc.learningPath.revision, title: next.learningPath.title, goal: next.learningPath.goal, editor: next.editor, application: next.application }
}
const addSkill = (d: Doc, title: string, position: { x: number; y: number }, taskTitles: string[] = []) => {
  const id = crypto.randomUUID()
  d.editor.cards.push({ id, title, position })
  d.application.skills.push({ id, title, outcome: `${title} outcome`, tasks: taskTitles.map((t) => ({ id: crypto.randomUUID(), title: t, description: `${t} notes` })) })
  return id
}
const edges = (d: Doc) => d.editor.connections.map((c) => `${c.from_id}>${c.to_id}`).sort()

/** A fresh Path with Skills A → B, each with a Task. */
async function authoredPath(title = 'Systems Rust', goal = 'Ship a small allocator') {
  const created: Doc = await json(createPath(title, goal), 201)
  let a = '', b = ''
  const saved: Doc = await json(save(created.learningPath.id, edit(created, (d) => {
    a = addSkill(d, 'Ownership', { x: 80, y: 100 }, ['Borrow exercises'])
    b = addSkill(d, 'Lifetimes', { x: 360, y: 220 }, ['Annotate lifetimes'])
    d.editor.connections.push({ from_id: a, to_id: b })
  })), 200)
  return { doc: saved, a, b }
}

async function storedState(pathId: string) {
  return {
    path: (await db.select().from(learningPaths).where(eq(learningPaths.id, pathId)))[0],
    skills: (await db.select().from(personalSkills).where(eq(personalSkills.learningPathId, pathId))).map((s) => [s.skillId, s.title, s.learningOutcome]).sort(),
    tasks: (await db.select().from(personalTasks).where(eq(personalTasks.learningPathId, pathId))).map((t) => [t.taskId, t.skillId, t.title, t.description]).sort(),
    cards: (await db.select().from(personalSkillCards).where(eq(personalSkillCards.learningPathId, pathId))).map((c) => [c.skillId, c.x, c.y]).sort(),
    edges: (await db.select().from(personalPrerequisites).where(eq(personalPrerequisites.learningPathId, pathId))).map((e) => `${e.prerequisiteSkillId}>${e.skillId}`).sort(),
  }
}

it('AC1: the owner creates and reopens several Paths, each with its own goal, Skills, Tasks and one card per Skill', async () => {
  const rust = await authoredPath('Systems Rust', 'Ship a small allocator')
  const guitar: Doc = await json(createPath('Jazz Guitar', 'Comp through a blues'), 201)
  expect(guitar.learningPath).toMatchObject({ title: 'Jazz Guitar', goal: 'Comp through a blues', revision: 0 })
  expect(guitar.learningPath.personalWorkspaceId).toBe(px.workspaces.learnerSpace.id)
  let chords = ''
  await json(save(guitar.learningPath.id, edit(guitar, (d) => { chords = addSkill(d, 'Shell voicings', { x: -40, y: 12.5 }, ['Drill ii-V-I', 'Transcribe a chorus']) })), 200)

  // Reopening each Path returns only its own content.
  const rustAgain: Doc = await json(read(rust.doc.learningPath.id), 200)
  const guitarAgain: Doc = await json(read(guitar.learningPath.id), 200)
  expect(rustAgain).toEqual(rust.doc)
  expect(rustAgain.learningPath).toMatchObject({ title: 'Systems Rust', goal: 'Ship a small allocator', revision: 1 })
  expect(rustAgain.application.skills.map((s) => s.title)).toEqual(['Ownership', 'Lifetimes'])
  expect(guitarAgain.application.skills.map((s) => [s.id, s.title, s.tasks.map((t) => t.title)])).toEqual([[chords, 'Shell voicings', ['Drill ii-V-I', 'Transcribe a chorus']]])
  expect(guitarAgain.editor.cards).toEqual([{ id: chords, title: 'Shell voicings', position: { x: -40, y: 12.5 } }])
  // Exactly one flat card per Skill, at its saved position.
  for (const doc of [rustAgain, guitarAgain]) expect(doc.editor.cards.map((c) => c.id)).toEqual(doc.application.skills.map((s) => s.id))
  expect((await storedState(rust.doc.learningPath.id)).cards).toEqual([[rust.a, 80, 100], [rust.b, 360, 220]].sort())

  // The Workspace lists every Path with its goal, beside the earlier personal Paths.
  const workspace = await json(request(`/personal/workspaces/${px.workspaces.learnerSpace.id}`), 200)
  // The two fixture Paths share one creation time, so only the new Paths have a defined order.
  const listed = workspace.learningPaths.map((p: any) => [p.title, p.goal])
  expect(listed.slice(0, 2).sort()).toEqual([['Personal Guitar', ''], ['Personal Rust', '']])
  expect(listed.slice(2)).toEqual([['Systems Rust', 'Ship a small allocator'], ['Jazz Guitar', 'Comp through a blues']])
  // A Path needs a title; nothing is created without one.
  for (const body of [{ title: '  ', goal: 'x' }, { goal: 'x' }, { title: 'x'.repeat(201) }, null]) {
    expect((await request('/personal/learning-paths', 'learner', 'POST', body)).status).toBe(422)
  }
  expect((await db.select().from(learningPaths).where(eq(learningPaths.personalWorkspaceId, px.workspaces.learnerSpace.id))).length).toBe(4)
})

it('AC1: a first Path also enters the Personal Workspace, and Skills created before T16 open with a default card', async () => {
  const doc: Doc = await json(createPath('First steps', '', 'unrelated'), 201)
  const workspace = await json(request('/personal/workspace', 'unrelated', 'PUT'), 200)
  expect(workspace.workspace.id).toBe(doc.learningPath.personalWorkspaceId)
  const main: Doc = await json(read(px.paths.main.id), 200)
  expect(main.application.skills.map((s) => s.title).sort()).toEqual(['Lifetimes', 'Ownership'])
  expect(main.editor.cards.map((c) => c.id)).toEqual(main.application.skills.map((s) => s.id))
  expect(new Set(main.editor.cards.map((c) => `${c.position.x},${c.position.y}`)).size).toBe(2)
  expect(main.editor.connections).toEqual([{ from_id: px.skills.skillA.id, to_id: px.skills.skillB.id }])
})

it('AC2/AC5: Tasks stay outside the editor snapshot, connections are the stored Prerequisites, and no view state is stored', async () => {
  const { doc, a, b } = await authoredPath()
  const taskId = doc.application.skills[1].tasks[0].id
  const next: Doc = await json(save(doc.learningPath.id, edit(doc, (d) => {
    d.application.skills[1].tasks[0].title = 'Annotate every lifetime'
    d.application.skills[0].outcome = 'Explain moves and borrows'
    d.editor.cards[1].position = { x: 400.25, y: -75 }
  })), 200)
  expect(next.learningPath.revision).toBe(2)
  const snapshot = JSON.stringify(next.editor)
  for (const text of ['Annotate every lifetime', 'Borrow exercises', 'Explain moves and borrows', taskId]) expect(snapshot).not.toContain(text)
  expect(Object.keys(next.editor).sort()).toEqual(['cards', 'connections', 'format_version'])
  for (const card of next.editor.cards) expect(Object.keys(card).sort()).toEqual(['id', 'position', 'title'])
  // No camera, selection or undo state anywhere in the durable document.
  expect(JSON.stringify(next)).not.toMatch(/camera|zoom|offset|select|undo|redo/i)
  const stored = await storedState(doc.learningPath.id)
  expect(stored.tasks.find((t) => t[0] === taskId)).toEqual([taskId, b, 'Annotate every lifetime', 'Annotate lifetimes notes'])
  expect(stored.edges).toEqual([`${a}>${b}`])
  expect(stored.cards).toEqual([[a, 80, 100], [b, 400.25, -75]].sort())
  // The Skill behind the Task is the one the card names, after another reopen.
  const reopened: Doc = await json(read(doc.learningPath.id), 200)
  expect(reopened).toEqual(next)
  const cardB = reopened.editor.cards.find((c) => c.id === b)!
  expect(reopened.application.skills.find((s) => s.id === cardB.id)!.tasks.map((t) => t.id)).toEqual([taskId])
})

it('AC2: content saves never touch the learning records kept beside the document', async () => {
  const before: Doc = await json(read(px.paths.main.id), 200)
  expect((await request(`/personal/learning-paths/${px.paths.main.id}/tasks/${px.tasks.taskA.id}/completion`, 'learner', 'PUT')).status).toBe(200)
  expect((await request(`/personal/learning-paths/${px.paths.main.id}/skills/${px.skills.skillA.id}/mastery`, 'learner', 'PUT')).status).toBe(200)
  const learning = async () => (await json(request(`/personal/learning-paths/${px.paths.main.id}/learning-state`), 200)).learningState
  const recorded = await learning()
  await json(save(px.paths.main.id, edit(before, (d) => {
    d.application.skills.find((s) => s.id === px.skills.skillA.id)!.tasks.find((t) => t.id === px.tasks.taskA.id)!.title = 'Borrow checker kata'
    d.editor.cards[0].position = { x: 999, y: 999 }
  })), 200)
  const after = await learning()
  expect(after.xp).toBe(recorded.xp)
  expect(after.xpHistory).toEqual(recorded.xpHistory)
  expect(after.masteryHistory).toEqual(recorded.masteryHistory)
  expect(after.tasks.find((t: any) => t.taskId === px.tasks.taskA.id)).toMatchObject({ title: 'Borrow checker kata', xpReward: 20, completed: true })
  expect(after.skills.map((s: any) => [s.skillId, s.mastery, s.xpThreshold]).sort()).toEqual(recorded.skills.map((s: any) => [s.skillId, s.mastery, s.xpThreshold]).sort())
})

it('AC3: only the owner reads or writes a Path; others get no Path and change nothing', async () => {
  const { doc } = await authoredPath()
  const before = await storedState(doc.learningPath.id)
  const hostile = edit(doc, (d) => { d.learningPath.title = 'Taken over'; addSkill(d, 'Injected', { x: 0, y: 0 }) })
  for (const actor of ['peer', 'coach', 'otherCoach', 'unrelated', 'unverified'] as const) {
    expect(await json(read(doc.learningPath.id, actor), 404)).toEqual({ error: 'learning_path_not_found' })
    expect(await json(save(doc.learningPath.id, hostile, actor), 404)).toEqual({ error: 'learning_path_not_found' })
    // An invalid edit is not a way to learn that the Path exists.
    expect(await json(save(doc.learningPath.id, { ...hostile, editor: { format_version: 2 } }, actor), 404)).toEqual({ error: 'learning_path_not_found' })
  }
  for (const response of [await read(doc.learningPath.id, null), await save(doc.learningPath.id, hostile, null), await createPath('Anon', '', null)]) expect(response.status).toBe(401)
  // Coach-mode, unknown and malformed Paths are equally absent to the learner; the peer's Path too.
  for (const pathId of [fx.paths.path.id, crypto.randomUUID(), 'not-a-uuid', px.paths.peers.id]) {
    expect((await read(pathId)).status).toBe(404)
    expect((await save(pathId, hostile)).status).toBe(404)
  }
  expect(await storedState(doc.learningPath.id)).toEqual(before)
})

it('AC3: one Path per Skill and one Skill per Task; a refused save writes nothing at all', async () => {
  const { doc, a, b } = await authoredPath()
  const before = await storedState(doc.learningPath.id)
  const taskOfA = doc.application.skills[0].tasks[0].id
  const cases: [string, number, ReturnType<typeof edit>][] = [
    // Another Path's Skill: the learner's other Path, the peer's Path, a coach-mode Path.
    ...[px.skills.otherSkill.id, px.skills.peerSkill.id, fx.content.skillA.id].map((id) => ['skill_owned_elsewhere', 409, edit(doc, (d) => {
      addSkill(d, 'Fresh', { x: 1, y: 1 }, ['Fresh task'])
      d.editor.cards.push({ id, title: 'Stolen', position: { x: 0, y: 0 } })
      d.application.skills.push({ id, title: 'Stolen', outcome: '', tasks: [] })
    })] as [string, number, ReturnType<typeof edit>]),
    // A Task moved to another Skill of the same Path.
    ['task_skill_mismatch', 409, edit(doc, (d) => {
      const [task] = d.application.skills[0].tasks.splice(0, 1)
      d.application.skills[1].tasks.push(task)
    })],
    // Another Path's Task, the peer's Task, a coach-mode Task.
    ...[px.tasks.otherTask.id, px.tasks.peerTask.id, fx.content.taskA.id].map((id) => ['task_owned_elsewhere', 409, edit(doc, (d) => {
      d.application.skills[0].tasks.push({ id, title: 'Stolen task', description: '' })
    })] as [string, number, ReturnType<typeof edit>]),
    // Removing content is not part of this slice.
    ['skill_missing', 422, edit(doc, (d) => {
      d.editor.cards.splice(1, 1); d.application.skills.splice(1, 1); d.editor.connections = []
    })],
    ['task_missing', 422, edit(doc, (d) => { d.application.skills[0].tasks = [] })],
  ]
  for (const [error, status, body] of cases) {
    expect(await json(save(doc.learningPath.id, body), status)).toMatchObject({ error })
    expect(await storedState(doc.learningPath.id)).toEqual(before)
  }
  // No claimed identity leaked into the logical tables either.
  expect((await db.select().from(skills).where(eq(skills.learningPathId, doc.learningPath.id))).map((s) => s.id).sort()).toEqual([a, b].sort())
  expect((await db.select().from(tasks).where(eq(tasks.id, taskOfA))).map((t) => t.skillId)).toEqual([a])
  // The other Paths kept their own content.
  expect((await db.select().from(personalSkills).where(eq(personalSkills.skillId, px.skills.otherSkill.id)))[0].title).toBe('Chords')
})

it('AC3: connections stay inside the Path and keep the Prerequisite Graph acyclic', async () => {
  const { doc, a, b } = await authoredPath()
  const before = await storedState(doc.learningPath.id)
  let c = ''
  const cases: [string, ReturnType<typeof edit>][] = [
    ['prerequisite_cycle', edit(doc, (d) => { d.editor.connections.push({ from_id: b, to_id: a }) })],
    ['prerequisite_cycle', edit(doc, (d) => { d.editor.connections.push({ from_id: a, to_id: a }) })],
    ['prerequisite_cycle', edit(doc, (d) => {
      c = addSkill(d, 'Allocators', { x: 600, y: 300 })
      d.editor.connections.push({ from_id: b, to_id: c }, { from_id: c, to_id: a })
    })],
    ['connection_outside_path', edit(doc, (d) => { d.editor.connections.push({ from_id: px.skills.skillA.id, to_id: a }) })],
    ['connection_outside_path', edit(doc, (d) => { d.editor.connections.push({ from_id: a, to_id: crypto.randomUUID() }) })],
    ['invalid_document', edit(doc, (d) => { d.editor.cards.pop() })],
    ['invalid_document', edit(doc, (d) => { d.editor.cards.push({ ...d.editor.cards[0] }) })],
    ['invalid_document', edit(doc, (d) => { d.editor.cards[0].title = 'Renamed only on the card' })],
    ['invalid_document', edit(doc, (d) => { d.editor.cards[0].position = { x: 1_000_001, y: 0 } })],
    ['invalid_document', edit(doc, (d) => { (d.editor as any).format_version = 2 })],
    ['invalid_document', edit(doc, (d) => { d.application.skills[0].id = 'skill-not-a-uuid'; d.editor.cards[0].id = 'skill-not-a-uuid' })],
  ]
  for (const [error, body] of cases) {
    expect(await json(save(doc.learningPath.id, body), 422)).toMatchObject({ error })
    expect(await storedState(doc.learningPath.id)).toEqual(before)
  }
  // Branching with several foundations is a valid DAG (US11).
  const branched: Doc = await json(save(doc.learningPath.id, edit(doc, (d) => {
    c = addSkill(d, 'Allocators', { x: 600, y: 300 })
    d.editor.connections.push({ from_id: a, to_id: c }, { from_id: b, to_id: c })
  })), 200)
  expect(edges(branched)).toEqual([`${a}>${b}`, `${a}>${c}`, `${b}>${c}`].sort())
  // Removing a connection is an edit too, and leaves the rest of the graph.
  const removed: Doc = await json(save(doc.learningPath.id, edit(branched, (d) => { d.editor.connections = d.editor.connections.filter((e) => e.to_id !== c || e.from_id !== b) })), 200)
  expect((await storedState(doc.learningPath.id)).edges).toEqual(edges(removed))
})

it('AC3: concurrent claims of one new Skill ID by two Paths let exactly one Path own it', async () => {
  const first: Doc = await json(createPath('One', ''), 201)
  const second: Doc = await json(createPath('Two', '', 'peer'), 201)
  const id = crypto.randomUUID()
  const claim = (d: Doc) => edit(d, (x) => { x.editor.cards.push({ id, title: 'Shared', position: { x: 0, y: 0 } }); x.application.skills.push({ id, title: 'Shared', outcome: '', tasks: [] }) })
  const statuses = (await Promise.all([save(first.learningPath.id, claim(first)), save(second.learningPath.id, claim(second), 'peer')])).map((r) => r.status).sort()
  expect(statuses).toEqual([200, 409])
  expect((await db.select().from(skills).where(eq(skills.id, id))).length).toBe(1)
})

it('AC4: a save based on an older revision is refused with the accepted document, which stays unchanged', async () => {
  const { doc, a } = await authoredPath()
  const tabOne = edit(doc, (d) => { d.application.skills[0].tasks[0].title = 'Tab one title'; d.editor.cards[0].position = { x: 10, y: 10 } })
  const tabTwo = edit(doc, (d) => { d.application.skills[0].tasks[0].title = 'Tab two title'; d.learningPath.goal = 'Tab two goal' })
  const accepted: Doc = await json(save(doc.learningPath.id, tabOne), 200)
  expect(accepted.learningPath.revision).toBe(doc.learningPath.revision + 1)
  const stale = await json(save(doc.learningPath.id, tabTwo), 409)
  expect(stale).toMatchObject({ error: 'stale_revision' })
  expect(stale.current).toEqual(accepted)
  const reopened: Doc = await json(read(doc.learningPath.id), 200)
  expect(reopened).toEqual(accepted)
  expect(reopened.application.skills[0].tasks[0].title).toBe('Tab one title')
  expect(reopened.learningPath.goal).toBe(doc.learningPath.goal)
  expect(reopened.editor.cards.find((c) => c.id === a)!.position).toEqual({ x: 10, y: 10 })
  // A save from the future is just as stale.
  expect((await save(doc.learningPath.id, { ...tabOne, expectedRevision: accepted.learningPath.revision + 5 })).status).toBe(409)
  // Resending the accepted document changes nothing and keeps the revision.
  const unchanged: Doc = await json(save(doc.learningPath.id, edit(accepted)), 200)
  expect(unchanged).toEqual(accepted)
  // Rebased on the accepted revision, the same edit is accepted.
  const rebased: Doc = await json(save(doc.learningPath.id, { ...tabTwo, expectedRevision: accepted.learningPath.revision }), 200)
  expect(rebased.learningPath).toMatchObject({ goal: 'Tab two goal', revision: accepted.learningPath.revision + 1 })
})

it('AC4: of competing saves on one revision exactly one is accepted', async () => {
  const { doc } = await authoredPath()
  const bodies = Array.from({ length: 8 }, (_, i) => edit(doc, (d) => { d.application.skills[0].tasks[0].title = `Competitor ${i}` }))
  const responses = await Promise.all(bodies.map((body) => save(doc.learningPath.id, body)))
  const statuses = responses.map((r) => r.status)
  expect(statuses.filter((s) => s === 200).length).toBe(1)
  expect(statuses.filter((s) => s === 409).length).toBe(7)
  const winner = bodies[statuses.indexOf(200)].application.skills[0].tasks[0].title
  const reopened: Doc = await json(read(doc.learningPath.id), 200)
  expect(reopened.learningPath.revision).toBe(doc.learningPath.revision + 1)
  expect(reopened.application.skills[0].tasks[0].title).toBe(winner)
})
