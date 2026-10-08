import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiResult } from '../../lib/api'
import type { Board, BoardColumn } from '../board/boardModel'
import { BoardSync, storedIntents, type BoardSaveAnswer, type BoardView } from '../board/boardSync'

const REFUSALS: Record<string, string> = {
  skill_locked: 'this Skill is locked, so a Task cannot enter the Completion Column',
  board_task_missing: 'a Task would be left without a column',
  board_task_unknown: 'a Task on this board is no longer one of this Skill\'s active Tasks',
  column_owned_elsewhere: 'a column belongs to another board',
  invalid_board: 'the board is not valid',
  skill_not_found: 'this Skill is not saved yet',
  learning_path_not_found: 'this Path is not available to the signed-in Account',
  draft_published: 'this Draft was published, so its board can no longer change; reload the page to see the latest version',
  draft_not_found: 'this Draft is not available to the signed-in Account',
  enrollment_not_found: 'this Enrollment is not available to the signed-in Account',
  learner_only: 'only the Enrollment\'s learner arranges this board',
  unauthenticated: 'you are signed out',
}

/**
 * Where one context's boards are read and saved: a personal Path's (answering its
 * learning records too), a Coach Draft's or a learner's Enrollment's (ADR 0027, 0029, 0030).
 */
export interface BoardStore<L> {
  read: (skillId: string) => Promise<ApiResult<{ board: Board }>>
  save: (skillId: string, expectedRevision: number, columns: BoardColumn[]) => Promise<ApiResult<{ board: Board; learningState?: L }>>
}

/**
 * The Task Boards of one Path or Draft (ADR 0027), one per Skill. Each keeps its own
 * pending board changes while the board is closed, so a refused or conflicting change
 * stays recoverable until the owner retries, reapplies or discards it. Only the open
 * board is shown; an accepted save, the first board read, or a board adopted with other
 * Tasks in its Completion Column calls `learningChanged`, since completion may have changed.
 * `scope` names the boards' owner (the Path and Draft, or the Enrollment); another scope starts afresh.
 */
export function useTaskBoards<L>({ scope, store, enabled, tasksOf, savedTasksOf, learningChanged, keptKey }: {
  scope: string
  store: BoardStore<L>
  enabled: boolean
  /** This tab's active Task IDs of a Skill, in document order. */
  tasksOf: (skillId: string) => string[]
  /** A Skill's Task IDs in the document the backend last accepted from this tab. */
  savedTasksOf: (skillId: string) => string[]
  learningChanged: () => void
  /**
   * Where a Skill's unaccepted intents are kept in this tab across its reloads (its key names the
   * Account, the boards' owner and the Skill); without it they live in this tab only (ADR 0028, 0030).
   */
  keptKey?: (skillId: string) => string
}) {
  const syncs = useRef(new Map<string, BoardSync<L>>())
  const [openId, setOpenId] = useState<string | null>(null)
  const openRef = useRef<string | null>(null)
  const [view, setView] = useState<BoardView | null>(null)
  const [pending, setPending] = useState(false)
  const latest = useRef({ store, tasksOf, savedTasksOf, learningChanged, keptKey })
  latest.current = { store, tasksOf, savedTasksOf, learningChanged, keptKey }

  const syncFor = useCallback((skillId: string) => {
    let sync = syncs.current.get(skillId)
    if (sync) return sync
    sync = new BoardSync<L>({
      read: async () => {
        try {
          const result = await latest.current.store.read(skillId)
          return result.ok ? { ok: true, board: result.value.board } : { ok: false, detail: REFUSALS[result.error] ?? result.error }
        } catch {
          return { ok: false, detail: 'the backend could not be reached' }
        }
      },
      save: async (expectedRevision, columns): Promise<BoardSaveAnswer<L>> => {
        const result = await latest.current.store.save(skillId, expectedRevision, columns)
        if (result.ok) return { kind: 'accepted', board: result.value.board, learning: result.value.learningState }
        if (result.error === 'stale_revision' && result.body?.current) return { kind: 'stale', current: result.body.current as never }
        const detail = REFUSALS[result.error] ?? result.error
        return result.status >= 500 ? { kind: 'failed', detail } : { kind: 'refused', detail }
      },
      localTaskIds: () => latest.current.tasksOf(skillId),
      savedTaskIds: () => latest.current.savedTasksOf(skillId),
      onAccepted: () => latest.current.learningChanged(),
      onCompletionChanged: () => latest.current.learningChanged(),
      // Each tab keeps its own intents (session storage survives the tab's reload), so no tab ever overwrites or clears another's.
      kept: latest.current.keptKey && storedIntents(() => (typeof window === 'undefined' ? null : window.sessionStorage), latest.current.keptKey(skillId)),
      onView: (next) => {
        if (openRef.current === skillId) setView(next)
        setPending([...syncs.current.values()].some((s) => s.view().pending > 0))
      },
    })
    syncs.current.set(skillId, sync)
    return sync
  }, [scope])

  useEffect(() => () => {
    for (const sync of syncs.current.values()) sync.close()
    syncs.current.clear()
  }, [scope])

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

  /**
   * Tells every board that this tab's document was accepted (saved, reloaded or reapplied). A
   * closed board whose intents wait for this tab's Tasks reads the board again, so they are sent
   * once the backend holds those Tasks instead of waiting until the board is reopened.
   */
  const documentAccepted = useCallback(() => {
    for (const [skillId, sync] of syncs.current) {
      sync.documentAccepted()
      if (skillId !== openRef.current && sync.view().pending > 0) void sync.refresh()
    }
  }, [])

  return { openId, view, sync: openId ? syncs.current.get(openId) ?? null : null, open, close, pending, documentAccepted }
}
