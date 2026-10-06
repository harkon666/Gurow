import { describe, expect, it } from 'bun:test'
import {
  keptWorkKey, layoutChanges, layoutWorkProblem, nameSkills, pathChanges, pathWorkProblem, readKeptWork, reapplyLayout, reapplyPath,
  removeKeptWork, sameLayoutWork, samePathWork, writeKeptWork, type KeptWork, type LayoutWork, type PathWork, type WorkContext,
} from './keptWork'

class MemoryStorage implements Storage {
  private items = new Map<string, string>()
  get length() { return this.items.size }
  clear() { this.items.clear() }
  getItem(key: string) { return this.items.get(key) ?? null }
  key(index: number) { return [...this.items.keys()][index] ?? null }
  removeItem(key: string) { this.items.delete(key) }
  setItem(key: string, value: string) { this.items.set(key, value) }
}

const doc = (): PathWork => ({
  title: 'Linear algebra',
  goal: 'Solve systems',
  editor: {
    format_version: 1,
    cards: [
      { id: 'vec', title: 'Vectors', position: { x: 100, y: 100 } },
      { id: 'mat', title: 'Matrices', position: { x: 400, y: 100 } },
    ],
    connections: [{ from_id: 'vec', to_id: 'mat' }],
  },
  application: {
    skills: [
      { id: 'vec', title: 'Vectors', outcome: 'Add vectors', tasks: [{ id: 't1', title: 'Sum two', description: 'Add (1,2) and (3,4)' }] },
      { id: 'mat', title: 'Matrices', outcome: 'Multiply matrices', tasks: [] },
    ],
  },
})

const edit = (work: PathWork, change: (work: PathWork) => void) => {
  const copy = structuredClone(work)
  change(copy)
  return copy
}

const lena: WorkContext = { accountId: 'lena', kind: 'draft', pathId: 'p1', versionId: 'v2' }
const kept = (context: WorkContext, id: string, mine = doc()): KeptWork<PathWork> => ({
  format: 1, id, context, baseRevision: 3, base: doc(), mine, editedAt: '2026-10-06T10:00:00.000Z',
})

describe('kept work in local storage', () => {
  it('is read only by its own Account, Path kind, Path and Learning Path Version', () => {
    const storage = new MemoryStorage()
    writeKeptWork(storage, kept(lena, 'w1'))
    expect(readKeptWork(storage, lena, pathWorkProblem).kept.map((w) => w.id)).toEqual(['w1'])
    for (const other of [
      { ...lena, accountId: 'pia' },
      { ...lena, kind: 'personal' as const, versionId: null },
      { ...lena, pathId: 'p2' },
      // The next Draft of the same Path, even at the same save revision.
      { ...lena, versionId: 'v3' },
    ]) {
      expect(readKeptWork(storage, other, pathWorkProblem)).toEqual({ kept: [], refused: [] })
    }
    // Another Account's reads removed nothing.
    expect(readKeptWork(storage, lena, pathWorkProblem).kept).toHaveLength(1)
  })

  it('removes and reports records that cannot be restored as they stand', () => {
    const storage = new MemoryStorage()
    const put = (id: string, value: unknown) => storage.setItem(keptWorkKey(lena, id), JSON.stringify(value))
    put('format', { ...kept(lena, 'format'), format: 2 })
    put('canvas', kept(lena, 'canvas', edit(doc(), (d) => { (d.editor as { format_version: number }).format_version = 2 })))
    // A record copied under this context's key from another Version.
    put('moved', kept({ ...lena, versionId: 'v1' }, 'moved'))
    put('revision', { ...kept(lena, 'revision'), baseRevision: -1 })
    put('orphan', kept(lena, 'orphan', edit(doc(), (d) => { d.editor.cards.pop() })))
    put('shared-task', kept(lena, 'shared-task', edit(doc(), (d) => { d.application.skills[1].tasks.push({ id: 't1', title: 'x', description: '' }) })))
    put('dangling', kept(lena, 'dangling', edit(doc(), (d) => { d.editor.connections.push({ from_id: 'mat', to_id: 'gone' }) })))
    storage.setItem(keptWorkKey(lena, 'garbage'), '{not json')
    writeKeptWork(storage, kept(lena, 'good'))

    const { kept: usable, refused } = readKeptWork(storage, lena, pathWorkProblem)
    expect(usable.map((w) => w.id)).toEqual(['good'])
    expect(refused.sort()).toEqual([
      'Skill mat has no card',
      'Task t1 belongs to more than one place',
      'a connection joins a Skill that is not in the Path',
      'it belongs to another Account, Path or Version',
      'it is not readable',
      'its base revision is not a revision',
      'its canvas format version 2 is not supported',
      'its record format 2 is not supported',
    ])
    expect(storage.length).toBe(1)
  })

  it('forgets one piece of work without touching another', () => {
    const storage = new MemoryStorage()
    writeKeptWork(storage, kept(lena, 'a'))
    writeKeptWork(storage, { ...kept(lena, 'b'), editedAt: '2026-10-06T09:00:00.000Z' })
    expect(readKeptWork(storage, lena, pathWorkProblem).kept.map((w) => w.id)).toEqual(['b', 'a'])
    removeKeptWork(storage, lena, 'b')
    expect(readKeptWork(storage, lena, pathWorkProblem).kept.map((w) => w.id)).toEqual(['a'])
  })
})

describe('reapplying Path work onto the accepted document', () => {
  it('keeps what was saved elsewhere and applies the owner\'s own changes', () => {
    const base = doc()
    const current = edit(base, (d) => {
      d.goal = 'Saved elsewhere'
      d.editor.cards[0].position = { x: 120, y: 140 }
      d.application.skills[0].tasks[0].description = 'Their wording'
    })
    const mine = edit(base, (d) => {
      d.application.skills[1].outcome = 'Multiply and invert matrices'
      d.editor.cards[1].position = { x: 450, y: 220 }
      d.application.skills[0].tasks.push({ id: 't2', title: 'Scale one', description: '' })
      d.editor.cards.push({ id: 'det', title: 'Determinants', position: { x: 700, y: 100 } })
      d.application.skills.push({ id: 'det', title: 'Determinants', outcome: 'Compute', tasks: [{ id: 't3', title: '2x2', description: '' }] })
      d.editor.connections.push({ from_id: 'mat', to_id: 'det' })
    })
    const merged = reapplyPath(base, mine, current)
    expect(pathWorkProblem(merged)).toBeNull()
    expect(merged.goal).toBe('Saved elsewhere')
    expect(merged.application.skills.map((s) => s.id)).toEqual(['vec', 'mat', 'det'])
    expect(merged.application.skills[0].tasks).toEqual([
      { id: 't1', title: 'Sum two', description: 'Their wording' },
      { id: 't2', title: 'Scale one', description: '' },
    ])
    expect(merged.application.skills[1].outcome).toBe('Multiply and invert matrices')
    expect(merged.editor.cards).toEqual([
      { id: 'vec', title: 'Vectors', position: { x: 120, y: 140 } },
      { id: 'mat', title: 'Matrices', position: { x: 450, y: 220 } },
      { id: 'det', title: 'Determinants', position: { x: 700, y: 100 } },
    ])
    expect(merged.editor.connections).toEqual([{ from_id: 'vec', to_id: 'mat' }, { from_id: 'mat', to_id: 'det' }])
  })

  it('lets the owner\'s change win where both sides changed the same field, and keeps Draft rules', () => {
    const base = edit(doc(), (d) => {
      d.application.skills[1].optional = false
      d.application.skills[1].xpThreshold = 0
      d.application.skills[0].tasks[0].required = true
      d.application.skills[0].tasks[0].xpReward = 10
    })
    const current = edit(base, (d) => { d.editor.cards[1].position = { x: 0, y: 0 }; d.application.skills[1].xpThreshold = 5; d.application.skills[0].tasks[0].xpReward = 20 })
    const mine = edit(base, (d) => { d.editor.cards[1].position = { x: 9, y: 9 }; d.application.skills[0].tasks[0].xpReward = 30 })
    const merged = reapplyPath(base, mine, current)
    expect(merged.editor.cards[1].position).toEqual({ x: 9, y: 9 })
    expect(merged.application.skills[1]).toMatchObject({ optional: false, xpThreshold: 5 })
    expect(merged.application.skills[0].tasks[0]).toEqual({ id: 't1', title: 'Sum two', description: 'Add (1,2) and (3,4)', required: true, xpReward: 30 })
  })

  it('applies the owner\'s connection removal and keeps connections added elsewhere, even when they form a cycle the backend must refuse', () => {
    const base = doc()
    const mine = edit(base, (d) => { d.editor.connections = [] })
    expect(reapplyPath(base, mine, base).editor.connections).toEqual([])

    const unconnected = edit(base, (d) => { d.editor.connections = [] })
    const theirs = edit(unconnected, (d) => { d.editor.connections = [{ from_id: 'vec', to_id: 'mat' }] })
    const reversed = edit(unconnected, (d) => { d.editor.connections = [{ from_id: 'mat', to_id: 'vec' }] })
    // Both directions: a proposal only, which the backend refuses as a cycle.
    expect(reapplyPath(unconnected, reversed, theirs).editor.connections).toEqual([{ from_id: 'vec', to_id: 'mat' }, { from_id: 'mat', to_id: 'vec' }])
  })

  it('reapplies nothing when the accepted document already holds the owner\'s changes', () => {
    const base = doc()
    const mine = edit(base, (d) => { d.goal = 'New goal'; d.editor.cards[0].position = { x: 1, y: 2 } })
    const current = edit(mine, (d) => { d.title = 'Renamed elsewhere' })
    expect(samePathWork(reapplyPath(base, mine, current), current)).toBe(true)
    expect(samePathWork(reapplyPath(base, base, current), current)).toBe(true)
  })

  it('compares documents regardless of card and connection order', () => {
    const a = edit(doc(), (d) => { d.editor.connections.push({ from_id: 'mat', to_id: 'vec' }) })
    const b = edit(a, (d) => { d.editor.cards.reverse(); d.editor.connections.reverse() })
    expect(samePathWork(a, b)).toBe(true)
    expect(samePathWork(a, edit(a, (d) => { d.application.skills.reverse() }))).toBe(false)
  })
})

describe('inspecting kept work', () => {
  it('lists the owner\'s changes in their terms', () => {
    const base = doc()
    const mine = edit(base, (d) => {
      d.goal = 'Invert matrices'
      d.application.skills[1].outcome = 'Multiply and invert'
      d.application.skills[1].tasks.push({ id: 't9', title: 'Invert a 2x2', description: '' })
      d.editor.cards[0].position = { x: 0, y: 0 }
      d.editor.connections = [{ from_id: 'mat', to_id: 'vec' }]
    })
    expect(pathChanges(base, mine)).toEqual([
      'Changed the goal to “Invert matrices”',
      'Edited the learning outcome of “Matrices”',
      'Added the Task “Invert a 2x2” to “Matrices”',
      'Moved the card “Vectors”',
      'Connected “Matrices” → “Vectors”',
      'Removed the connection “Vectors” → “Matrices”',
    ])
    expect(pathChanges(base, base)).toEqual([])
  })

  it('names Skills in a backend refusal', () => {
    expect(nameSkills('the Prerequisites form a cycle through vec → mat → vec', doc().application.skills))
      .toBe('the Prerequisites form a cycle through “Vectors” → “Matrices” → “Vectors”')
  })
})

describe('reapplying layout work', () => {
  const layout = (): LayoutWork => [{ id: 'vec', position: { x: 100, y: 100 } }, { id: 'mat', position: { x: 400, y: 100 } }]

  it('applies the owner\'s moves onto the accepted layout and keeps moves made elsewhere', () => {
    const base = layout()
    const current: LayoutWork = [{ id: 'vec', position: { x: 50, y: 50 } }, { id: 'mat', position: { x: 400, y: 100 } }]
    const mine: LayoutWork = [{ id: 'vec', position: { x: 100, y: 100 } }, { id: 'mat', position: { x: 500, y: 300 } }, { id: 'ghost', position: { x: 0, y: 0 } }]
    expect(reapplyLayout(base, mine, current)).toEqual([{ id: 'vec', position: { x: 50, y: 50 } }, { id: 'mat', position: { x: 500, y: 300 } }])
    expect(layoutChanges(base, mine, new Map([['mat', 'Matrices']]))).toEqual(['Moved the card “Matrices”'])
    expect(sameLayoutWork(reapplyLayout(base, base, current), current)).toBe(true)
  })

  it('refuses malformed layouts', () => {
    expect(layoutWorkProblem(layout())).toBeNull()
    expect(layoutWorkProblem([{ id: 'vec', position: { x: Number.NaN, y: 0 } }])).toBe('a card is malformed')
    expect(layoutWorkProblem([...layout(), layout()[0]])).toBe('card vec appears twice')
    expect(layoutWorkProblem({})).toBe('its layout is not a list of cards')
  })
})
