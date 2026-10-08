/**
 * Deleting a Skill (ADR 0018): only content without learning history is deleted, with
 * its Tasks, card and connections, as one editor undo step. A Skill with history is
 * kept; the control says so and points to archiving the Skill instead.
 */
export function DeleteSkillControl({ skillId, title, taskCount, history, blocked, onDelete }: {
  skillId: string
  title: string
  taskCount: number
  /** Why the Skill cannot be deleted because of its learning history, or null when it has none. */
  history: string | null
  /** Why deleting is not possible right now (history still loading, editor busy), or null. */
  blocked: string | null
  onDelete: () => void
}) {
  if (history) {
    return (
      <p id="skill-delete-blocked" data-skill-id={skillId} className="text-[11px] text-slate-400 bg-slate-800/40 border border-slate-700/40 rounded-lg px-2.5 py-1.5">
        {history}
      </p>
    )
  }
  const what = taskCount === 0 ? 'and its connections' : `with its ${taskCount === 1 ? 'Task' : `${taskCount} Tasks`} and connections`
  return (
    <button
      id="delete-skill-btn"
      data-skill-id={skillId}
      onClick={onDelete}
      disabled={blocked !== null}
      title={blocked ?? `Delete “${title}” ${what}. Undo brings it back.`}
      className="self-start text-[11px] text-red-200 bg-red-950/40 hover:bg-red-900/50 disabled:opacity-50 disabled:cursor-not-allowed border border-red-900/60 px-2 py-1 rounded-lg cursor-pointer"
    >
      Delete Skill
    </button>
  )
}
