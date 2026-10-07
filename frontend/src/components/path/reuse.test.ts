import { describe, expect, it } from 'bun:test'
import type { PathSkill } from '../../lib/api'
import { draftRuleProblem } from './DraftRules'
import { copySkills, copyTask, prerequisitesOf, type Destination, type ReuseContent } from './reuse'

// The editor's two modes, as PathEditor defines them.
const personal: Destination = {
  kind: 'personal',
  newSkill: (id, title, outcome) => ({ id, title, outcome, tasks: [] }),
  newTask: (id) => ({ id, title: 'New Task', description: '' }),
}
const draft: Destination = {
  kind: 'coach',
  newSkill: (id, title, outcome) => ({ id, title, outcome, optional: false, xpThreshold: 0, tasks: [] }),
  newTask: (id) => ({ id, title: 'New Task', description: '', required: true, xpReward: 0 }),
}

const ids = () => {
  let n = 0
  return () => `new-${++n}`
}

/** A Coach's Version: Vectors → Matrices → Eigen, and Optional Proofs → Optional History. */
const coachSkills: PathSkill[] = [
  { id: 'vectors', title: 'Vectors', outcome: 'Add vectors', optional: false, xpThreshold: 0, tasks: [{ id: 'v1', title: 'Vector drills', description: 'Ten sums', required: true, xpReward: 20 }, { id: 'v2', title: 'Read chapter 1', description: '', required: false, xpReward: 5 }] },
  { id: 'matrices', title: 'Matrices', outcome: 'Multiply', optional: false, xpThreshold: 20, tasks: [{ id: 'm1', title: 'Matrix drills', description: '', required: true, xpReward: 30 }] },
  { id: 'eigen', title: 'Eigen', outcome: 'Diagonalise', optional: false, xpThreshold: 50, tasks: [] },
  { id: 'proofs', title: 'Proofs', outcome: 'Prove', optional: true, xpThreshold: 0, tasks: [] },
  { id: 'history', title: 'History', outcome: 'Tell it', optional: true, xpThreshold: 0, tasks: [] },
]
const coachVersion: ReuseContent = {
  kind: 'coach',
  skills: coachSkills,
  cards: [
    { id: 'vectors', position: { x: 100, y: 300 } },
    { id: 'matrices', position: { x: 400, y: 350 } },
    { id: 'eigen', position: { x: 700, y: 300 } },
    { id: 'proofs', position: { x: 100, y: 600 } },
    { id: 'history', position: { x: 400, y: 600 } },
  ],
  connections: [{ from_id: 'vectors', to_id: 'matrices' }, { from_id: 'matrices', to_id: 'eigen' }, { from_id: 'proofs', to_id: 'history' }],
}
const personalPath: ReuseContent = {
  kind: 'personal',
  skills: [{ id: 'ownership', title: 'Ownership', outcome: 'Explain moves', tasks: [{ id: 'o1', title: 'Borrow checker', description: 'Fix ten errors' }] }],
  cards: [{ id: 'ownership', position: { x: 0, y: 0 } }],
  connections: [],
}

describe('copying Skills', () => {
  it('gives every copied Skill and Task a new ID and keeps titles, outcomes and descriptions', () => {
    const copy = copySkills(coachVersion, ['vectors', 'matrices'], draft, [], ids())
    expect(copy.skills.map((s) => [s.id, s.title, s.outcome])).toEqual([['new-1', 'Vectors', 'Add vectors'], ['new-2', 'Matrices', 'Multiply']])
    expect(copy.skills.flatMap((s) => s.tasks.map((t) => [t.id, t.title, t.description]))).toEqual([['new-3', 'Vector drills', 'Ten sums'], ['new-4', 'Read chapter 1', ''], ['new-5', 'Matrix drills', '']])
    // One card per copied Skill, titled like it.
    expect(copy.cards.map((c) => [c.id, c.title])).toEqual([['new-1', 'Vectors'], ['new-2', 'Matrices']])
  })

  it('keeps only the Prerequisites among the copied Skills, under their new IDs', () => {
    const copy = copySkills(coachVersion, ['matrices', 'eigen'], draft, [], ids())
    expect(copy.connections).toEqual([{ from_id: 'new-1', to_id: 'new-2' }])
    expect(prerequisitesOf(coachVersion, ['matrices', 'eigen'])).toEqual({ kept: [{ from_id: 'matrices', to_id: 'eigen' }], left: 1 })
    // A Skill copied alone brings no Prerequisite, in either direction.
    expect(copySkills(coachVersion, ['matrices'], draft, [], ids()).connections).toEqual([])
    expect(prerequisitesOf(coachVersion, ['matrices'])).toEqual({ kept: [], left: 2 })
    expect(prerequisitesOf(coachVersion, ['history'])).toEqual({ kept: [], left: 1 })
  })

  it('keeps the Draft rules from a Coach Version into a Draft, and the result passes the Draft rules', () => {
    const copy = copySkills(coachVersion, ['proofs', 'history', 'matrices'], draft, [], ids())
    expect(copy.skills.map((s) => [s.title, s.optional, s.xpThreshold])).toEqual([['Matrices', false, 20], ['Proofs', true, 0], ['History', true, 0]])
    expect(copy.skills[0].tasks).toEqual([{ id: 'new-4', title: 'Matrix drills', description: '', required: true, xpReward: 30 }])
    expect(draftRuleProblem(copy.skills, copy.connections)).toBeNull()
  })

  it('drops the Draft rules into a personal Path, where rewards and thresholds are learning records', () => {
    const copy = copySkills(coachVersion, ['vectors'], personal, [], ids())
    expect(copy.skills).toEqual([{ id: 'new-1', title: 'Vectors', outcome: 'Add vectors', tasks: [{ id: 'new-2', title: 'Vector drills', description: 'Ten sums' }, { id: 'new-3', title: 'Read chapter 1', description: '' }] }])
  })

  it('starts personal content in a Draft with the rules of a new Skill and Task', () => {
    const copy = copySkills(personalPath, ['ownership'], draft, [], ids())
    expect(copy.skills).toEqual([{ id: 'new-1', title: 'Ownership', outcome: 'Explain moves', optional: false, xpThreshold: 0, tasks: [{ id: 'new-2', title: 'Borrow checker', description: 'Fix ten errors', required: true, xpReward: 0 }] }])
  })

  it('keeps the arrangement of the copied cards and places them right of the destination cards', () => {
    const destination = [{ position: { x: 80, y: 120 } }, { position: { x: 500, y: 40 } }]
    const copy = copySkills(coachVersion, ['vectors', 'matrices', 'eigen'], draft, destination, ids())
    expect(copy.cards.map((c) => c.position)).toEqual([{ x: 780, y: 40 }, { x: 1080, y: 90 }, { x: 1380, y: 40 }])
    expect(copySkills(personalPath, ['ownership'], personal, [], ids()).cards[0].position).toEqual({ x: 80, y: 100 })
  })

  it('copies nothing when no Skill of the source is chosen', () => {
    expect(copySkills(coachVersion, ['unknown'], draft, [], ids())).toEqual({ skills: [], cards: [], connections: [] })
  })
})

describe('copying one Task', () => {
  it('gives it a new ID in its destination Skill and keeps rules only between Coach content', () => {
    const task = coachSkills[0].tasks[1]
    expect(copyTask(task, 'coach', draft, () => 'fresh')).toEqual({ id: 'fresh', title: 'Read chapter 1', description: '', required: false, xpReward: 5 })
    expect(copyTask(task, 'coach', personal, () => 'fresh')).toEqual({ id: 'fresh', title: 'Read chapter 1', description: '' })
    expect(copyTask(personalPath.skills[0].tasks[0], 'personal', draft, () => 'fresh')).toEqual({ id: 'fresh', title: 'Borrow checker', description: 'Fix ten errors', required: true, xpReward: 0 })
  })
})
