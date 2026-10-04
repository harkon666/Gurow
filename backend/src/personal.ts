import { and, asc, desc, eq, sql, type SQL } from 'drizzle-orm'
import type { Database } from './db/client'
import { lockedTimestamp } from './db/clock'
import { learningPaths, personalMasteryEvents, personalOverrideRecords, personalPrerequisites, personalSkills, personalTasks, personalWorkspaces, personalXpEvents } from './db/schema'

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0]

export type PersonalRefusal = 'learning_path_not_found' | 'task_not_found' | 'skill_not_found' | 'task_archived' | 'skill_locked'
type Outcome = { ok: true; changed: boolean } | { ok: false; refusal: PersonalRefusal }

/**
 * Derives a personal Path's progress from its own Tasks only (ADR 0009): no other
 * Path, Enrollment or coach evidence is read. Completed Tasks, archived or not,
 * contribute their current reward. Mastery is the owner's declaration; Access
 * follows current declared Mastery and Path XP unless the latest override is a grant.
 */
async function derivePersonalState(tx: Pick<Database, 'select'>, learningPathId: string) {
  const skills = await tx.select().from(personalSkills).where(eq(personalSkills.learningPathId, learningPathId)).orderBy(asc(personalSkills.skillId))
  const definitions = await tx.select().from(personalTasks).where(eq(personalTasks.learningPathId, learningPathId)).orderBy(asc(personalTasks.taskId))
  const prerequisites = await tx.select().from(personalPrerequisites).where(eq(personalPrerequisites.learningPathId, learningPathId)).orderBy(asc(personalPrerequisites.prerequisiteSkillId))
  const overrideHistory = await tx.select().from(personalOverrideRecords).where(eq(personalOverrideRecords.learningPathId, learningPathId)).orderBy(asc(personalOverrideRecords.sequence))
  const latestOverrides = new Map(overrideHistory.map((record) => [record.skillId, record]))
  const tasks = definitions.map((task) => ({ ...task, completed: task.completedAt !== null, xpContribution: task.completedAt !== null ? task.xpReward : 0 }))
  const xp = tasks.reduce((total, task) => total + task.xpContribution, 0)
  const mastered = new Set(skills.filter((skill) => skill.masteryDeclaredAt !== null).map((skill) => skill.skillId))
  return {
    learningPathId, xp, tasks, overrideHistory,
    skills: skills.map(({ personalWorkspaceId: _, ...skill }) => {
      const unmetPrerequisiteSkillIds = prerequisites.filter((edge) => edge.skillId === skill.skillId && !mastered.has(edge.prerequisiteSkillId)).map((edge) => edge.prerequisiteSkillId)
      const xpShortfall = Math.max(0, skill.xpThreshold - xp)
      const latest = latestOverrides.get(skill.skillId)
      const accessOverride = latest?.action === 'grant' ? latest : null
      return { ...skill, mastery: mastered.has(skill.skillId), access: accessOverride !== null || xpShortfall === 0 && unmetPrerequisiteSkillIds.length === 0, accessOverride, unmetPrerequisiteSkillIds, xpShortfall }
    }),
  }
}

/** Locks the Path row only for its owner; every other Account sees no Path at all (ADR 0012).
 * All personal mutators and reads hold this lock through commit, so a check and its
 * change or a multi-query read observe one state.
 */
async function lockOwnedPath(tx: Tx, learningPathId: string, accountId: string) {
  const [path] = await tx.select({ id: learningPaths.id }).from(learningPaths)
    .innerJoin(personalWorkspaces, eq(personalWorkspaces.id, learningPaths.personalWorkspaceId))
    .where(and(eq(learningPaths.id, learningPathId), eq(personalWorkspaces.ownerAccountId, accountId)))
    .for('update', { of: learningPaths })
  return path ?? null
}

async function readState(tx: Tx, learningPathId: string) {
  return {
    ...await derivePersonalState(tx, learningPathId),
    xpHistory: await tx.select().from(personalXpEvents).where(eq(personalXpEvents.learningPathId, learningPathId)).orderBy(asc(personalXpEvents.id)),
    masteryHistory: await tx.select().from(personalMasteryEvents).where(eq(personalMasteryEvents.learningPathId, learningPathId)).orderBy(asc(personalMasteryEvents.id)),
  }
}

export type PersonalLearningState = Awaited<ReturnType<typeof readState>>

export async function readPersonalLearningState(db: Database, learningPathId: string, accountId: string): Promise<PersonalLearningState | null> {
  return db.transaction(async (tx) => (await lockOwnedPath(tx, learningPathId, accountId)) ? readState(tx, learningPathId) : null)
}

/** Runs one owner action under the Path lock and returns the committed state it produced. */
async function act(db: Database, learningPathId: string, accountId: string, change: (tx: Tx, now: SQL) => Promise<Outcome>) {
  return db.transaction(async (tx) => {
    if (!await lockOwnedPath(tx, learningPathId, accountId)) return { ok: false, refusal: 'learning_path_not_found' } as const
    const outcome = await change(tx, await lockedTimestamp(tx))
    return outcome.ok ? { ok: true, changed: outcome.changed, learningState: await readState(tx, learningPathId) } as const : outcome
  })
}

async function activeTask(tx: Tx, learningPathId: string, taskId: string) {
  const [task] = await tx.select().from(personalTasks).where(and(eq(personalTasks.learningPathId, learningPathId), eq(personalTasks.taskId, taskId)))
  if (!task) return { ok: false, refusal: 'task_not_found' } as const
  // Archival removes the Task from active use and freezes its retained contribution.
  if (task.archivedAt) return { ok: false, refusal: 'task_archived' } as const
  return { ok: true, task } as const
}

async function hasAccess(tx: Tx, learningPathId: string, skillId: string) {
  return (await derivePersonalState(tx, learningPathId)).skills.find((skill) => skill.skillId === skillId)?.access ?? false
}

/** Records a nonzero change in one Task's contribution; the first completion is its XP Award. */
async function recordXp(tx: Tx, task: typeof personalTasks.$inferSelect, accountId: string, occurredAt: SQL, cause: 'completion' | 'completion_undone' | 'reward_change', amount: number) {
  if (amount === 0) return
  const [prior] = await tx.select({ id: personalXpEvents.id }).from(personalXpEvents).where(and(eq(personalXpEvents.learningPathId, task.learningPathId), eq(personalXpEvents.taskId, task.taskId))).limit(1)
  await tx.insert(personalXpEvents).values({ learningPathId: task.learningPathId, taskId: task.taskId, actorAccountId: accountId, occurredAt, cause, amount, kind: cause === 'completion' && !prior ? 'award' : 'correction' })
}

/** Marking complete needs current Access but no evidence or review, and never declares Mastery. */
export const completeTask = (db: Database, learningPathId: string, taskId: string, accountId: string) => act(db, learningPathId, accountId, async (tx, now) => {
  const found = await activeTask(tx, learningPathId, taskId)
  if (!found.ok) return found
  if (found.task.completedAt) return { ok: true, changed: false }
  if (!await hasAccess(tx, learningPathId, found.task.skillId)) return { ok: false, refusal: 'skill_locked' }
  await tx.update(personalTasks).set({ completedAt: now, startedAt: sql`coalesce(${personalTasks.startedAt}, ${now})` }).where(eq(personalTasks.taskId, taskId))
  await recordXp(tx, found.task, accountId, now, 'completion', found.task.xpReward)
  return { ok: true, changed: true }
})

/** Undoing is a correction, so it is allowed while locked; started work and Mastery stay. */
export const undoTaskCompletion = (db: Database, learningPathId: string, taskId: string, accountId: string) => act(db, learningPathId, accountId, async (tx, now) => {
  const found = await activeTask(tx, learningPathId, taskId)
  if (!found.ok) return found
  if (!found.task.completedAt) return { ok: true, changed: false }
  await tx.update(personalTasks).set({ completedAt: null }).where(eq(personalTasks.taskId, taskId))
  await recordXp(tx, found.task, accountId, now, 'completion_undone', -found.task.xpReward)
  return { ok: true, changed: true }
})

/** A completed Task's contribution follows its new reward by the difference; an incomplete one stays zero. */
export const changeTaskReward = (db: Database, learningPathId: string, taskId: string, accountId: string, xpReward: number) => act(db, learningPathId, accountId, async (tx, now) => {
  const found = await activeTask(tx, learningPathId, taskId)
  if (!found.ok) return found
  if (found.task.xpReward === xpReward) return { ok: true, changed: false }
  await tx.update(personalTasks).set({ xpReward }).where(eq(personalTasks.taskId, taskId))
  if (found.task.completedAt) await recordXp(tx, found.task, accountId, now, 'reward_change', xpReward - found.task.xpReward)
  return { ok: true, changed: true }
})

/** The first start is kept; a later relock leaves it recorded but blocks completion. */
export const startTask = (db: Database, learningPathId: string, taskId: string, accountId: string) => act(db, learningPathId, accountId, async (tx, now) => {
  const found = await activeTask(tx, learningPathId, taskId)
  if (!found.ok) return found
  if (found.task.startedAt) return { ok: true, changed: false }
  if (!await hasAccess(tx, learningPathId, found.task.skillId)) return { ok: false, refusal: 'skill_locked' }
  await tx.update(personalTasks).set({ startedAt: now }).where(eq(personalTasks.taskId, taskId))
  return { ok: true, changed: true }
})

/** One-way here: no restoration policy is defined. Contribution, Mastery and history are untouched. */
export const archiveTask = (db: Database, learningPathId: string, taskId: string, accountId: string) => act(db, learningPathId, accountId, async (tx, now) => {
  const [task] = await tx.select().from(personalTasks).where(and(eq(personalTasks.learningPathId, learningPathId), eq(personalTasks.taskId, taskId)))
  if (!task) return { ok: false, refusal: 'task_not_found' }
  if (task.archivedAt) return { ok: true, changed: false }
  await tx.update(personalTasks).set({ archivedAt: now }).where(eq(personalTasks.taskId, taskId))
  return { ok: true, changed: true }
})

async function findSkill(tx: Tx, learningPathId: string, skillId: string) {
  const [skill] = await tx.select().from(personalSkills).where(and(eq(personalSkills.learningPathId, learningPathId), eq(personalSkills.skillId, skillId)))
  return skill ?? null
}

/** Free declaration or withdrawal: no evidence, Access or XP is involved or changed. */
export const setMastery = (db: Database, learningPathId: string, skillId: string, accountId: string, declared: boolean) => act(db, learningPathId, accountId, async (tx, now) => {
  const skill = await findSkill(tx, learningPathId, skillId)
  if (!skill) return { ok: false, refusal: 'skill_not_found' }
  if ((skill.masteryDeclaredAt !== null) === declared) return { ok: true, changed: false }
  await tx.update(personalSkills).set({ masteryDeclaredAt: declared ? now : null }).where(eq(personalSkills.skillId, skillId))
  await tx.insert(personalMasteryEvents).values({ learningPathId, skillId, actorAccountId: accountId, occurredAt: now, action: declared ? 'declare' : 'withdraw' })
  return { ok: true, changed: true }
})

/** Waives both gates for one Skill without a reason; XP and Mastery are not touched. */
export const setAccessOverride = (db: Database, learningPathId: string, skillId: string, accountId: string, granted: boolean) => act(db, learningPathId, accountId, async (tx, now) => {
  if (!await findSkill(tx, learningPathId, skillId)) return { ok: false, refusal: 'skill_not_found' }
  const [latest] = await tx.select().from(personalOverrideRecords).where(and(eq(personalOverrideRecords.learningPathId, learningPathId), eq(personalOverrideRecords.skillId, skillId))).orderBy(desc(personalOverrideRecords.sequence)).limit(1)
  if ((latest?.action === 'grant') === granted) return { ok: true, changed: false }
  await tx.insert(personalOverrideRecords).values({ learningPathId, skillId, actorAccountId: accountId, action: granted ? 'grant' : 'revoke', occurredAt: now })
  return { ok: true, changed: true }
})
