import { useCallback, useEffect, useRef, useState } from 'react'
import { readPersonalBoard, savePersonalBoard, type LearningState } from '../../lib/api'
import { BoardSync, type BoardSaveAnswer, type BoardView } from '../board/boardSync'

const REFUSALS: Record<string, string> = {
  skill_locked: 'this Skill is locked, so a Task cannot enter the Completion Column',
  board_task_missing: 'a Task would be left without a column',
  board_task_unknown: 'a Task on this board is no longer one of this Skill\'s active Tasks',
  column_owned_elsewhere: 'a column belongs to another board',
  invalid_board: 'the board is not valid',
  skill_not_found: 'this Skill is not saved yet',
  learning_path_not_found: 'this Path is not available to the signed-in Account',
  unauthenticated: 'you are signed out',
}

/**
 * The personal Task Boards of one Path (ADR 0027), one per Skill. Each keeps its own
 * pending board changes while the board is closed, so a refused or conflicting change
 * stays recoverable until the owner retries, reapplies or discards it. Only the open
 * board is shown; an accepted save, the first board read, or a board adopted with other
 * Tasks in its Completion Column calls `learningChanged`, since completion may have changed.
 */
export function usePersonalBoards({ pathId, enabled, tasksOf, savedTasksOf, learningChanged }: {
  pathId: string
  enabled: boolean
  /** This tab's active Task IDs of a Skill, in document order. */
  tasksOf: (skillId: string) => string[]
  /** A Skill's Task IDs in the document the backend last accepted from this tab. */
  savedTasksOf: (skillId: string) => string[]
  learningChanged: () => void
}) {
  const syncs = useRef(new Map<string, BoardSync<LearningState>>())
  const [openId, setOpenId] = useState<string | null>(null)
  const openRef = useRef<string | null>(null)
  const [view, setView] = useState<BoardView | null>(null)
  const [pending, setPending] = useState(false)
  const latest = useRef({ tasksOf, savedTasksOf, learningChanged })
  latest.current = { tasksOf, savedTasksOf, learningChanged }

  const syncFor = useCallback((skillId: string) => {
    let sync = syncs.current.get(skillId)
    if (sync) return sync
    sync = new BoardSync<LearningState>({
      read: async () => {
        try {
          const result = await readPersonalBoard(pathId, skillId)
          return result.ok ? { ok: true, board: result.value.board } : { ok: false, detail: REFUSALS[result.error] ?? result.error }
        } catch {
          return { ok: false, detail: 'the backend could not be reached' }
        }
      },
      save: async (expectedRevision, columns): Promise<BoardSaveAnswer<LearningState>> => {
        const result = await savePersonalBoard(pathId, skillId, expectedRevision, columns)
        if (result.ok) return { kind: 'accepted', board: result.value.board, learning: result.value.learningState }
        if (result.error === 'stale_revision' && result.body?.current) return { kind: 'stale', current: result.body.current as never }
        const detail = REFUSALS[result.error] ?? result.error
        return result.status >= 500 ? { kind: 'failed', detail } : { kind: 'refused', detail }
      },
      localTaskIds: () => latest.current.tasksOf(skillId),
      savedTaskIds: () => latest.current.savedTasksOf(skillId),
      onAccepted: () => latest.current.learningChanged(),
      onCompletionChanged: () => latest.current.learningChanged(),
      onView: (next) => {
        if (openRef.current === skillId) setView(next)
        setPending([...syncs.current.values()].some((s) => s.view().pending > 0))
      },
    })
    syncs.current.set(skillId, sync)
    return sync
  }, [pathId])

  useEffect(() => () => { for (const sync of syncs.current.values()) sync.close() }, [])

  const open = useCallback((skillId: string) => {
    if (!enabled) return
    openRef.current = skillId
    setOpenId(skillId)
    setView(syncFor(skillId).view())
  }, [enabled, syncFor])
  const close = useCallback(() => {
    openRef.current = null
    setOpenId(null)
    setView(null)
  }, [])

  /** Tells every board that this tab's document was accepted (saved, reloaded or reapplied). */
  const documentAccepted = useCallback(() => { for (const sync of syncs.current.values()) sync.documentAccepted() }, [])

  return { openId, view, sync: openId ? syncs.current.get(openId) ?? null : null, open, close, pending, documentAccepted }
}
