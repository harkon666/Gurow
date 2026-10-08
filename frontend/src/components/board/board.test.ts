import { describe, expect, it } from 'bun:test'
import { applyOp, applyOps, completionEffects, localColumns, removalChoices, type Board, type BoardColumn } from './boardModel'
import { BoardSync, type BoardSaveAnswer, type BoardView } from './boardSync'

const board = (revision = 0): Board => ({
  skillId: 's',
  revision,
  columns: [
    { id: 'backlog', name: 'Backlog', completion: false, taskIds: ['t1', 't2'] },
    { id: 'doing', name: 'In Progress', completion: false, taskIds: ['t3'] },
    { id: 'done', name: 'Done', completion: true, taskIds: ['t4'] },
  ],
})
const arranged = (columns: BoardColumn[]) => columns.map((c) => `${c.name}${c.completion ? '*' : ''}:${c.taskIds.join(',')}`)

describe('board intents (UX03 AC2/AC4/AC5)', () => {
  it('moves cards within and across columns without losing any', () => {
    const within = applyOp(board().columns, { kind: 'move', taskId: 't2', columnId: 'backlog', index: 0 })
    expect(within.status === 'applied' && arranged(within.columns)).toEqual(['Backlog:t2,t1', 'In Progress:t3', 'Done*:t4'])
    const across = applyOp(board().columns, { kind: 'move', taskId: 't1', columnId: 'done', index: 0 })
    expect(across.status === 'applied' && arranged(across.columns)).toEqual(['Backlog:t2', 'In Progress:t3', 'Done*:t1,t4'])
    // A Task created here whose save is on the way waits; a Task gone from the board, or a column that is gone, makes the intent obsolete.
    expect(applyOp(board().columns, { kind: 'move', taskId: 'new', columnId: 'done', index: 0 }, new Set(['new'])).status).toBe('waiting')
    expect(applyOp(board().columns, { kind: 'move', taskId: 'new', columnId: 'done', index: 0 }).status).toBe('obsolete')
    expect(applyOp(board().columns, { kind: 'move', taskId: 't1', columnId: 'gone', index: 0 }).status).toBe('obsolete')
  })

  it('removes a populated column only into a surviving destination, and hands the Completion role to a replacement', () => {
    const removed = applyOp(board().columns, { kind: 'remove-column', columnId: 'backlog', destinationId: 'doing' })
    expect(removed.status === 'applied' && arranged(removed.columns)).toEqual(['In Progress:t3,t1,t2', 'Done*:t4'])
    expect(applyOp(board().columns, { kind: 'remove-column', columnId: 'backlog', destinationId: 'backlog' }).status).toBe('obsolete')
    // The Completion Column needs a replacement.
    expect(applyOp(board().columns, { kind: 'remove-column', columnId: 'done', destinationId: 'backlog' }).status).toBe('obsolete')
    const replaced = applyOp(board().columns, { kind: 'remove-column', columnId: 'done', destinationId: 'backlog', replacementId: 'doing' })
    expect(replaced.status === 'applied' && arranged(replaced.columns)).toEqual(['Backlog:t1,t2,t4', 'In Progress*:t3'])
    // Its consequences: t4 leaves completion, t3 enters it.
    expect(replaced.status === 'applied' && completionEffects(board().columns, replaced.columns).sort((a, b) => a.taskId.localeCompare(b.taskId)))
      .toEqual([{ taskId: 't3', completed: true }, { taskId: 't4', completed: false }])
    // The last usable column is never removed.
    const two = applyOp(board().columns, { kind: 'remove-column', columnId: 'backlog', destinationId: 'doing' })
    expect(two.status === 'applied' && removalChoices(two.columns, 'doing').blocked).toContain('at least two columns')
  })

  it('renames, adds and reorders columns; a role, not a name, makes the Completion Column', () => {
    const result = applyOps(board().columns, [
      { kind: 'rename-column', columnId: 'done', name: 'Finished' },
      { kind: 'rename-column', columnId: 'doing', name: 'Done' },
      { kind: 'add-column', columnId: 'review', name: 'Review', index: 2 },
      { kind: 'move-column', columnId: 'backlog', index: 2 },
      { kind: 'rename-column', columnId: 'review', name: '   ' },
    ])
    expect(arranged(result.columns)).toEqual(['Done:t3', 'Review:', 'Backlog:t1,t2', 'Finished*:t4'])
    expect(result.dropped).toHaveLength(1)
  })

  it('shows Tasks deleted here as gone and Tasks added here in place before their save', () => {
    const shown = localColumns(board().columns, [{ kind: 'move', taskId: 'new', columnId: 'doing', index: 0 }], ['t1', 't3', 't4', 'new'], new Set(['new']))
    expect(arranged(shown)).toEqual(['Backlog:t1', 'In Progress:new,t3', 'Done*:t4'])
  })
})

/** A BoardSync over a scripted backend: each save waits for the test to answer it. */
function harness(initial = board(), localTaskIds = ['t1', 't2', 't3', 't4']) {
  const views: BoardView[] = []
  const saves: { expectedRevision: number; columns: BoardColumn[]; answer: (a: BoardSaveAnswer<string>) => void }[] = []
  const learning: string[] = []
  const completionChanged: number[] = []
  const local = { ids: localTaskIds, saved: initial.columns.flatMap((c) => c.taskIds) }
  let readBoard = initial
  const sync = new BoardSync<string>({
    read: async () => ({ ok: true, board: readBoard }),
    save: (expectedRevision, columns) => new Promise((answer) => saves.push({ expectedRevision, columns, answer })),
    localTaskIds: () => local.ids,
    savedTaskIds: () => local.saved,
    onView: (view) => views.push(view),
    onAccepted: (l) => learning.push(l ?? ''),
    onCompletionChanged: () => completionChanged.push(views.length),
  })
  return { sync, views, saves, learning, completionChanged, local, setRead: (b: Board) => { readBoard = b }, last: () => views.at(-1)! }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('board saves (UX03 AC9)', () => {
  it('shows a move at once but calls it saved only after the backend accepts it', async () => {
    const h = harness()
    await h.sync.refresh()
    h.sync.perform({ kind: 'move', taskId: 't1', columnId: 'done', index: 0 })
    expect(h.last().status.kind).toBe('saving')
    expect(arranged(h.last().columns)).toContain('Done*:t1,t4')
    expect(h.saves).toHaveLength(1)
    expect(h.saves[0].expectedRevision).toBe(0)
    const accepted = { ...board(1), columns: h.saves[0].columns }
    h.saves[0].answer({ kind: 'accepted', board: accepted, learning: 'xp 20' })
    await tick()
    expect(h.last().status.kind).toBe('saved')
    expect(h.last().accepted?.revision).toBe(1)
    expect(h.learning).toEqual(['xp 20'])
  })

  it('keeps a failed move for Retry, which resends the same board on the same revision', async () => {
    const h = harness()
    await h.sync.refresh()
    h.sync.perform({ kind: 'move', taskId: 't2', columnId: 'doing', index: 1 })
    h.saves[0].answer({ kind: 'failed', detail: 'the backend could not be reached' })
    await tick()
    expect(h.last().status).toEqual({ kind: 'failed', detail: 'the backend could not be reached' })
    expect(h.last().pending).toBe(1)
    expect(arranged(h.last().columns)).toContain('In Progress:t3,t2')
    h.sync.retry()
    expect(h.saves).toHaveLength(2)
    expect(h.saves[1]).toMatchObject({ expectedRevision: 0, columns: h.saves[0].columns })
  })

  it('never replaces a newer board after a stale save: the owner reapplies or discards', async () => {
    const h = harness()
    await h.sync.refresh()
    h.sync.perform({ kind: 'move', taskId: 't1', columnId: 'doing', index: 0 })
    const newer: Board = { ...board(4), columns: [...board().columns.slice(0, 2), { id: 'done', name: 'Finished', completion: true, taskIds: ['t4', 't2'] }].map((c, i) => i === 0 ? { ...c, taskIds: ['t1'] } : c) }
    h.saves[0].answer({ kind: 'stale', current: newer })
    await tick()
    expect(h.last().status.kind).toBe('conflict')
    // The local intent is still shown and nothing more is sent on its own.
    expect(arranged(h.last().columns)).toContain('In Progress:t1,t3')
    expect(h.saves).toHaveLength(1)
    h.sync.reapply()
    expect(h.saves[1].expectedRevision).toBe(4)
    expect(arranged(h.saves[1].columns)).toEqual(['Backlog:', 'In Progress:t1,t3', 'Finished*:t4,t2'])
    h.saves[1].answer({ kind: 'stale', current: newer })
    await tick()
    h.sync.discard()
    expect(arranged(h.last().columns)).toEqual(arranged(newer.columns))
    expect(h.last().pending).toBe(0)
  })

  it('waits for this tab\'s new Task to reach the board before saving its placement', async () => {
    const h = harness(board(), ['t1', 't2', 't3', 't4', 'new'])
    await h.sync.refresh()
    h.sync.perform({ kind: 'move', taskId: 'new', columnId: 'doing', index: 0 })
    expect(h.last().status.kind).toBe('waiting')
    expect(h.saves).toHaveLength(0)
    expect(arranged(h.last().columns)).toContain('In Progress:new,t3')
    // The document save added it; the backend placed it in Backlog; the intent now applies.
    h.setRead({ ...board(1), columns: board().columns.map((c) => c.id === 'backlog' ? { ...c, taskIds: [...c.taskIds, 'new'] } : c) })
    await h.sync.refresh()
    expect(h.saves).toHaveLength(1)
    expect(h.saves[0].expectedRevision).toBe(1)
    expect(arranged(h.saves[0].columns)).toEqual(['Backlog:t1,t2', 'In Progress:new,t3', 'Done*:t4'])
  })

  it('does not save while a Task deleted here is still on the backend board', async () => {
    const h = harness()
    await h.sync.refresh()
    h.local.ids = ['t1', 't3', 't4']
    h.sync.perform({ kind: 'move', taskId: 't1', columnId: 'doing', index: 0 })
    expect(h.saves).toHaveLength(0)
    expect(arranged(h.last().columns)).toEqual(['Backlog:', 'In Progress:t1,t3', 'Done*:t4'])
    h.setRead({ ...board(1), columns: board().columns.map((c) => c.id === 'backlog' ? { ...c, taskIds: ['t1'] } : c) })
    await h.sync.refresh()
    expect(h.saves).toHaveLength(1)
  })

  it('a failed move is retried on its own revision; a newer board read meanwhile becomes a conflict, never a silent rebase', async () => {
    const h = harness()
    await h.sync.refresh()
    h.sync.perform({ kind: 'move', taskId: 't1', columnId: 'doing', index: 0, columnName: 'In Progress' })
    h.saves[0].answer({ kind: 'failed', detail: 'the backend could not be reached' })
    await tick()
    // Another tab completed t3 meanwhile (revision 2); reopening the board reads it.
    h.setRead({ ...board(2), columns: board().columns.map((c) => c.id === 'doing' ? { ...c, taskIds: [] } : c.id === 'done' ? { ...c, taskIds: ['t4', 't3'] } : c) })
    await h.sync.refresh()
    expect(h.last().status.kind).toBe('conflict')
    expect(h.last().pending).toBe(1)
    expect(h.last().accepted?.revision).toBe(0)
    h.sync.retry()
    expect(h.saves).toHaveLength(1)
    // Only an explicit reapply sends the change on the newer revision, keeping the other tab's completion.
    h.sync.reapply()
    expect(h.saves[1].expectedRevision).toBe(2)
    expect(arranged(h.saves[1].columns)).toEqual(['Backlog:t2', 'In Progress:t1', 'Done*:t4,t3'])
  })

  it('without a newer board, Retry resends the original request', async () => {
    const h = harness()
    await h.sync.refresh()
    h.sync.perform({ kind: 'move', taskId: 't1', columnId: 'doing', index: 0 })
    h.saves[0].answer({ kind: 'failed', detail: 'x' })
    await tick()
    await h.sync.refresh()
    h.sync.retry()
    expect(h.saves[1]).toMatchObject({ expectedRevision: 0, columns: h.saves[0].columns })
  })

  it('keeps an intent whose column was removed elsewhere until the owner redirects or discards it', async () => {
    const h = harness()
    await h.sync.refresh()
    h.sync.perform({ kind: 'move', taskId: 't1', columnId: 'doing', index: 0, columnName: 'In Progress' })
    const removed: Board = { ...board(3), columns: [{ id: 'backlog', name: 'Backlog', completion: false, taskIds: ['t1', 't2', 't3'] }, board().columns[2]] }
    h.saves[0].answer({ kind: 'stale', current: removed })
    await tick()
    h.sync.reapply()
    expect(h.last().status.kind).toBe('unapplied')
    expect(h.last().pending).toBe(1)
    expect(h.saves).toHaveLength(1)
    const status = h.last().status as { kind: 'unapplied'; ops: any[] }
    h.sync.redirect(status.ops[0], 'done', 'Done')
    expect(h.saves[1].expectedRevision).toBe(3)
    expect(arranged(h.saves[1].columns)).toEqual(['Backlog:t2,t3', 'Done*:t4,t1'])

    // Discarding instead drops only that intent, explicitly.
    const d = harness()
    await d.sync.refresh()
    d.sync.perform({ kind: 'move', taskId: 't1', columnId: 'doing', index: 0 })
    d.saves[0].answer({ kind: 'stale', current: removed })
    await tick()
    d.sync.reapply()
    d.sync.discardUnapplied()
    expect(d.last()).toMatchObject({ status: { kind: 'saved' }, pending: 0 })
    expect(d.saves).toHaveLength(1)
  })

  it('a waiting intent follows a newer board only for added or removed cards; organization changes are conflicts', async () => {
    const h = harness(board(), ['t1', 't2', 't3', 't4', 'new'])
    await h.sync.refresh()
    h.sync.perform({ kind: 'move', taskId: 'new', columnId: 'doing', index: 0 })
    h.setRead({ ...board(1), columns: board().columns.map((c) => c.id === 'backlog' ? { ...c, name: 'Someday', taskIds: [...c.taskIds, 'new'] } : c) })
    await h.sync.refresh()
    expect(h.last().status.kind).toBe('conflict')
    expect(h.saves).toHaveLength(0)
  })

  it('an intent about a Task deleted or archived elsewhere is unapplied, never stuck waiting, and can be discarded', async () => {
    const h = harness()
    await h.sync.refresh()
    h.sync.perform({ kind: 'move', taskId: 't2', columnId: 'doing', index: 0 })
    h.saves[0].answer({ kind: 'failed', detail: 'x' })
    await tick()
    // t2 was deleted (another tab's save, or this tab's document); the newer board no longer holds it.
    h.local.ids = ['t1', 't3', 't4']
    h.setRead({ ...board(1), columns: board().columns.map((c) => c.id === 'backlog' ? { ...c, taskIds: ['t1'] } : c) })
    await h.sync.refresh()
    expect(h.last().status.kind).toBe('conflict')
    h.sync.reapply()
    expect(h.last().status).toMatchObject({ kind: 'unapplied', ops: [{ taskId: 't2' }] })
    h.sync.discardUnapplied()
    // The failed save's answer was lost, so the board is confirmed with the backend before it is called saved.
    expect(h.last()).toMatchObject({ status: { kind: 'saving' }, pending: 0 })
    expect(h.saves[1]).toMatchObject({ expectedRevision: 1, columns: h.last().accepted!.columns })
    h.saves[1].answer({ kind: 'accepted', board: h.last().accepted! })
    await tick()
    expect(h.last()).toMatchObject({ status: { kind: 'saved' }, pending: 0 })
  })

  it('a Task added and deleted here before its save takes its placement along; later edits still save', async () => {
    const h = harness(board(), ['t1', 't2', 't3', 't4', 'new'])
    await h.sync.refresh()
    h.sync.perform({ kind: 'move', taskId: 'new', columnId: 'doing', index: 0 })
    h.local.ids = ['t1', 't2', 't3', 't4']
    h.sync.forgetTask('new')
    h.sync.perform({ kind: 'rename-column', columnId: 'backlog', name: 'Someday' })
    expect(h.saves).toHaveLength(1)
    expect(arranged(h.saves[0].columns)).toEqual(['Someday:t1,t2', 'In Progress:t3', 'Done*:t4'])
  })

  it('a read answered after a later accepted save, or after a newer read, never takes the board back', async () => {
    const reads: ((b: Board) => void)[] = []
    const saves: ((a: BoardSaveAnswer<string>) => void)[] = []
    const views: BoardView[] = []
    const sync = new BoardSync<string>({
      read: () => new Promise((resolve) => reads.push((b) => resolve({ ok: true, board: b }))),
      save: () => new Promise((resolve) => saves.push(resolve)),
      localTaskIds: () => ['t1', 't2', 't3', 't4'],
      savedTaskIds: () => ['t1', 't2', 't3', 't4'],
      onView: (view) => views.push(view),
    })
    const first = sync.refresh(); reads[0](board(0)); await first
    // A refresh is in flight when the owner moves t1 to Done and the save is accepted.
    const late = sync.refresh()
    sync.perform({ kind: 'move', taskId: 't1', columnId: 'done', index: 0 })
    saves[0]({ kind: 'accepted', board: { ...board(1), columns: [{ ...board().columns[0], taskIds: ['t2'] }, board().columns[1], { ...board().columns[2], taskIds: ['t1', 't4'] }] } })
    await tick()
    reads[1](board(0))
    await late
    expect(views.at(-1)!.accepted?.revision).toBe(1)
    expect(arranged(views.at(-1)!.columns)).toContain('Done*:t1,t4')
    // Two overlapping reads: the older answer arriving last is ignored.
    const older = sync.refresh(), newer = sync.refresh()
    const newest = { ...board(3), columns: board(1).columns.map((c) => ({ ...c, name: `${c.name}!` })) }
    reads[3](newest); await newer
    reads[2]({ ...board(2) }); await older
    expect(views.at(-1)!.accepted?.revision).toBe(3)
  })

  it('a Task deleted while a save is in flight drops only its own intent; a rename made meanwhile is still saved', async () => {
    const h = harness()
    await h.sync.refresh()
    h.sync.perform({ kind: 'move', taskId: 't2', columnId: 'doing', index: 0 })
    h.local.ids = ['t1', 't3', 't4']
    h.sync.forgetTask('t2')
    h.sync.perform({ kind: 'rename-column', columnId: 'done', name: 'Finished' })
    h.saves[0].answer({ kind: 'accepted', board: { ...board(1), columns: h.saves[0].columns } })
    await tick()
    // The deletion still has to reach the backend, then the rename is sent.
    expect(h.last()).toMatchObject({ status: { kind: 'waiting' }, pending: 1 })
    h.local.saved = ['t1', 't3', 't4']
    h.sync.documentAccepted()
    h.setRead({ ...board(2), columns: h.saves[0].columns.map((c) => ({ ...c, taskIds: c.taskIds.filter((id) => id !== 't2') })) })
    await h.sync.refresh()
    expect(h.saves).toHaveLength(2)
    expect(arranged(h.saves[1].columns)).toEqual(['Backlog:t1', 'In Progress:t3', 'Finished*:t4'])
  })

  it('after a lost answer, local changes that return to the accepted board are confirmed, never assumed saved', async () => {
    const h = harness()
    await h.sync.refresh()
    h.sync.perform({ kind: 'move', taskId: 't1', columnId: 'done', index: 0 })
    h.saves[0].answer({ kind: 'failed', detail: 'the backend could not be reached' })
    await tick()
    h.sync.perform({ kind: 'move', taskId: 't1', columnId: 'backlog', index: 0 })
    h.sync.retry()
    expect(h.saves).toHaveLength(2)
    expect(h.saves[1]).toMatchObject({ expectedRevision: 0, columns: board().columns })
    // The lost save had been committed: the backend answers with the board it holds, as a conflict.
    const committed: Board = { ...board(1), columns: h.saves[0].columns }
    h.saves[1].answer({ kind: 'stale', current: committed })
    await tick()
    expect(h.last().status).toEqual({ kind: 'conflict', current: committed })
    expect(h.views.slice(1).some((v) => v.status.kind === 'saved')).toBe(false)
  })

  it('a Task this tab still shows but another tab deleted does not block the board or reappear on it', async () => {
    const h = harness()
    await h.sync.refresh()
    // Another tab deleted t2; this tab's document still holds it, but the board read after its last document does not.
    h.setRead({ ...board(1), columns: board().columns.map((c) => c.id === 'backlog' ? { ...c, taskIds: ['t1'] } : c) })
    await h.sync.refresh()
    expect(h.last().goneTaskIds).toEqual(['t2'])
    expect(arranged(h.last().columns)).toEqual(['Backlog:t1', 'In Progress:t3', 'Done*:t4'])
    h.sync.perform({ kind: 'rename-column', columnId: 'backlog', name: 'Someday' })
    expect(h.saves).toHaveLength(1)
    expect(arranged(h.saves[0].columns)).toEqual(['Someday:t1', 'In Progress:t3', 'Done*:t4'])
  })

  it('reapplying onto a conflicting board read after this tab\'s document neither shows nor waits for a Task deleted elsewhere', async () => {
    const h = harness()
    await h.sync.refresh()
    h.sync.perform({ kind: 'rename-column', columnId: 'backlog', name: 'Someday' })
    h.saves[0].answer({ kind: 'failed', detail: 'the backend could not be reached' })
    await tick()
    // This tab's document is saved (same Tasks), then another tab deletes t2 and the board is read: a conflict.
    h.sync.documentAccepted()
    h.setRead({ ...board(1), columns: board().columns.map((c) => c.id === 'backlog' ? { ...c, taskIds: ['t1'] } : c) })
    await h.sync.refresh()
    expect(h.last().status.kind).toBe('conflict')
    h.sync.reapply()
    expect(h.last().goneTaskIds).toEqual(['t2'])
    expect(arranged(h.last().columns)).toEqual(['Someday:t1', 'In Progress:t3', 'Done*:t4'])
    expect(h.saves).toHaveLength(2)
    expect(h.saves[1].expectedRevision).toBe(1)
    expect(arranged(h.saves[1].columns)).toEqual(['Someday:t1', 'In Progress:t3', 'Done*:t4'])
  })

  it('the board a save would send includes Tasks added elsewhere, so removal consequences match what is saved (UX03 AC5)', async () => {
    // Another tab added t9 to In Progress; this tab's document does not know it yet.
    const h = harness({ ...board(1), columns: board().columns.map((c) => c.id === 'doing' ? { ...c, taskIds: ['t3', 't9'] } : c) })
    h.local.saved = ['t1', 't2', 't3', 't4']
    await h.sync.refresh()
    expect(arranged(h.last().columns)).toContain('In Progress:t3')
    expect(arranged(h.last().boardColumns)).toContain('In Progress:t3,t9')
    const op = { kind: 'remove-column', columnId: 'done', destinationId: 'backlog', replacementId: 'doing' } as const
    const preview = applyOp(h.last().boardColumns, op)
    const shown = preview.status === 'applied' ? completionEffects(h.last().boardColumns, preview.columns) : []
    h.sync.perform(op)
    const sent = completionEffects(h.last().accepted!.columns, h.saves[0].columns)
    const byTask = (a: { taskId: string }, b: { taskId: string }) => a.taskId.localeCompare(b.taskId)
    expect(shown.sort(byTask)).toEqual(sent.sort(byTask))
    expect(shown).toContainEqual({ taskId: 't9', completed: true })
  })

  it('the first board read, or a board adopted from a read or a recovery with other completed Tasks, reads the learning records again', async () => {
    const h = harness()
    // Opening the board: another tab may have completed Tasks since this tab read its records.
    await h.sync.refresh()
    expect(h.completionChanged).toHaveLength(1)
    // A read with the same completion changes nothing; another tab completing t1 does.
    await h.sync.refresh()
    expect(h.completionChanged).toHaveLength(1)
    h.setRead({ ...board(1), columns: [{ ...board().columns[0], taskIds: ['t2'] }, board().columns[1], { ...board().columns[2], taskIds: ['t1', 't4'] }] })
    await h.sync.refresh()
    expect(h.completionChanged).toHaveLength(2)
    // A lost completion is reversed here; Retry answers stale with the committed board; Discard adopts it.
    h.sync.perform({ kind: 'move', taskId: 't3', columnId: 'done', index: 0 })
    h.saves[0].answer({ kind: 'failed', detail: 'the backend could not be reached' })
    await tick()
    h.sync.perform({ kind: 'move', taskId: 't3', columnId: 'doing', index: 0 })
    h.sync.retry()
    const committed: Board = { ...board(2), columns: h.saves[0].columns }
    h.saves[1].answer({ kind: 'stale', current: committed })
    await tick()
    expect(h.completionChanged).toHaveLength(2)
    h.sync.discard()
    expect(h.last().status.kind).toBe('saved')
    expect(arranged(h.last().columns)).toContain('Done*:t3,t1,t4')
    expect(h.completionChanged).toHaveLength(3)
  })
})

describe('Draft preparation boards (UX04 AC3/AC4)', () => {
  const draft = (): BoardColumn[] => [
    { id: 'ideas', name: 'Ideas', completion: false, taskIds: ['t1', 't2'] },
    { id: 'prep', name: 'In preparation', completion: false, taskIds: [] },
    { id: 'ready', name: 'Ready', completion: false, taskIds: ['t3'] },
  ]

  it('moving to Ready or removing columns has no completion effect, whatever the names', () => {
    const moved = applyOp(draft(), { kind: 'move', taskId: 't1', columnId: 'ready', index: 0 })
    expect(moved.status === 'applied' && arranged(moved.columns)).toEqual(['Ideas:t2', 'In preparation:', 'Ready:t1,t3'])
    expect(moved.status === 'applied' && completionEffects(draft(), moved.columns)).toEqual([])
    const renamed = applyOp(draft(), { kind: 'rename-column', columnId: 'ready', name: 'Done' })
    expect(renamed.status === 'applied' && completionEffects(draft(), renamed.columns)).toEqual([])
    const removed = applyOp(draft(), { kind: 'remove-column', columnId: 'ready', destinationId: 'ideas' })
    expect(removed.status === 'applied' && arranged(removed.columns)).toEqual(['Ideas:t1,t2,t3', 'In preparation:'])
    expect(removed.status === 'applied' && completionEffects(draft(), removed.columns)).toEqual([])
  })

  it('keeps the last column: one column is enough, none is not', () => {
    expect(removalChoices(draft(), 'ready')).toMatchObject({ blocked: null, replacements: [] })
    const one: BoardColumn[] = [{ id: 'ideas', name: 'Ideas', completion: false, taskIds: ['t1'] }]
    expect(removalChoices(one, 'ideas').blocked).toBe('A board keeps at least one column.')
    expect(applyOp(one, { kind: 'remove-column', columnId: 'ideas', destinationId: 'ideas' }).status).toBe('obsolete')
  })

  it('places a Task created here at the end of the first column until its save reaches the board', () => {
    expect(arranged(localColumns(draft(), [], ['t1', 't2', 't3', 'new'], new Set(['new'])))).toEqual(['Ideas:t1,t2,new', 'In preparation:', 'Ready:t3'])
  })
})
