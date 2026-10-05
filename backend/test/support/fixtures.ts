import { eq, sql } from 'drizzle-orm'
import type { Database } from '../../src/db/client'
import type { Tx } from '../../src/personal'
import { accounts, coachWorkspaces, enrollmentInvitations, learningPaths, learningPathVersions, personalPrerequisites, personalSkills, personalTasks, personalWorkspaces, skills, tasks, versionSkills, versionTasks } from '../../src/db/schema'

/**
 * Controlled P2 fixture (SPEC decision 29): Accounts with known email states, one
 * owning Coach Workspace with two published Paths, a second Workspace, and
 * Invitations to exactly one Version each. Version 1 of the offered Path holds
 * published learning content shaped like the P2 reference Path: Skill A with a
 * Required and an Enrichment Task, and Skill B with a Required Task. Version 2
 * redefines the same logical Skills and Tasks (ADR 0004). Fixture names double as the
 * test-only identity header values; they are not production authentication.
 */
export async function seedEnrollmentFixture(db: Database) {
  const [coach, learner, peer, unrelated, otherCoach, unverified] = await db.insert(accounts).values([
    { email: 'coach@gurow.test', emailVerified: true },
    { email: 'Learner@Gurow.test', emailVerified: true },
    { email: 'peer@gurow.test', emailVerified: true },
    { email: 'unrelated@gurow.test', emailVerified: true },
    { email: 'other-coach@gurow.test', emailVerified: true },
    { email: 'unverified@gurow.test', emailVerified: false },
  ]).returning()

  const [workspace, otherWorkspace] = await db.insert(coachWorkspaces).values([
    { ownerAccountId: coach.id, name: 'Linear Algebra with Coach' },
    { ownerAccountId: otherCoach.id, name: 'Another Coach' },
  ]).returning()
  const [path, siblingPath] = await db.insert(learningPaths).values([
    { coachWorkspaceId: workspace.id, title: 'Linear Algebra' },
    { coachWorkspaceId: workspace.id, title: 'Calculus' },
  ]).returning()
  const published = new Date('2026-10-02T00:00:00Z')
  const [siblingVersion, closedVersion] = await db.insert(learningPathVersions).values([
    { learningPathId: siblingPath.id, versionNumber: 1, title: 'Calculus', publishedAt: published },
    { learningPathId: siblingPath.id, versionNumber: 2, title: 'Calculus', publishedAt: published, enrollmentClosedAt: published },
  ]).returning()

  const [skillA, skillB] = await db.insert(skills).values([{ learningPathId: path.id }, { learningPathId: path.id }]).returning()
  const [taskA, taskAReading, taskB] = await db.insert(tasks).values([{ skillId: skillA.id }, { skillId: skillA.id }, { skillId: skillB.id }]).returning()
  const content = (versionId: string, revision: string) => ({
    skills: [
      { learningPathVersionId: versionId, skillId: skillA.id, title: `Vectors${revision}`, learningOutcome: 'Add and scale vectors in R^n' },
      { learningPathVersionId: versionId, skillId: skillB.id, title: `Matrices${revision}`, learningOutcome: 'Multiply matrices and interpret them as linear maps' },
    ],
    tasks: [
      { learningPathVersionId: versionId, taskId: taskA.id, skillId: skillA.id, title: `Vector exercises${revision}`, required: true },
      { learningPathVersionId: versionId, taskId: taskAReading.id, skillId: skillA.id, title: 'Read chapter 1', required: false },
      { learningPathVersionId: versionId, taskId: taskB.id, skillId: skillB.id, title: `Matrix exercises${revision}`, required: true },
    ],
  })
  // Each Version is written as a Draft and then published; published content is immutable (migration 0012).
  const publishVersion = async (versionNumber: number, revision: string) => {
    const [draft] = await db.insert(learningPathVersions).values({ learningPathId: path.id, versionNumber, title: 'Linear Algebra' }).returning()
    const { skills: skillRows, tasks: taskRows } = content(draft.id, revision)
    await db.insert(versionSkills).values(skillRows)
    await db.insert(versionTasks).values(taskRows)
    const [version] = await db.update(learningPathVersions).set({ publishedAt: published }).where(eq(learningPathVersions.id, draft.id)).returning()
    return version
  }
  const version1 = await publishVersion(1, '')
  const version2 = await publishVersion(2, ' (revised)')

  const invite = (versionId: string, email: string) => ({ learningPathVersionId: versionId, email, invitedByAccountId: coach.id })
  const [toLearner, toLearnerAgain, toPeer, toUnverified, toOwner, toLearnerClosed] = await db.insert(enrollmentInvitations).values([
    invite(version1.id, 'learner@gurow.test'),
    invite(version1.id, 'LEARNER@gurow.test'),
    invite(version1.id, 'peer@gurow.test'),
    invite(version1.id, 'unverified@gurow.test'),
    invite(version1.id, 'coach@gurow.test'),
    invite(closedVersion.id, 'learner@gurow.test'),
  ]).returning()

  return {
    accounts: { coach, learner, peer, unrelated, otherCoach, unverified },
    workspaces: { workspace, otherWorkspace },
    paths: { path, siblingPath },
    versions: { version1, version2, siblingVersion, closedVersion },
    content: { skillA, skillB, taskA, taskAReading, taskB },
    invitations: { toLearner, toLearnerAgain, toPeer, toUnverified, toOwner, toLearnerClosed },
    /** Test-only identity: fixture name → Account ID. */
    identities: {
      coach: coach.id, learner: learner.id, peer: peer.id, unrelated: unrelated.id,
      otherCoach: otherCoach.id, unverified: unverified.id,
    },
  }
}

export type EnrollmentFixture = Awaited<ReturnType<typeof seedEnrollmentFixture>>

const PUBLISHED_CONTENT_GUARDS = [
  ['version_skills', 'version_skills_published_immutable'],
  ['version_tasks', 'version_tasks_published_immutable'],
  ['version_prerequisites', 'version_prerequisites_published_immutable'],
] as const

/**
 * Test setup only: configures the content of an already published fixture Version
 * (a reward, a threshold, an extra Prerequisite), which the database otherwise
 * refuses (ADR 0005, migration 0012). As the schema owner, it disables the guards
 * inside this one transaction and restores them before commit, so no other session
 * ever runs without them. Application code has no such path.
 */
export async function amendPublished<T>(db: Database, write: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    for (const [table, trigger] of PUBLISHED_CONTENT_GUARDS) await tx.execute(sql.raw(`alter table ${table} disable trigger ${trigger}`))
    const result = await write(tx)
    for (const [table, trigger] of PUBLISHED_CONTENT_GUARDS) await tx.execute(sql.raw(`alter table ${table} enable trigger ${trigger}`))
    return result
  })
}

/**
 * Owner-only personal fixture on top of {@link seedEnrollmentFixture}'s Accounts:
 * the learner's Personal Workspace holds a main Path (Skill A with 20-XP and
 * 10-XP Tasks; Skill B behind A's Mastery and a 20-XP Threshold, with a 5-XP Task)
 * and a second Path whose 100-XP Task must never count toward the main Path.
 * The peer owns a separate Path. Rewards and thresholds start as configured here.
 */
export async function seedPersonalFixture(db: Database, fx: EnrollmentFixture) {
  const [learnerSpace, peerSpace] = await db.insert(personalWorkspaces).values([
    { ownerAccountId: fx.accounts.learner.id },
    { ownerAccountId: fx.accounts.peer.id },
  ]).returning()
  const [main, other, peers] = await db.insert(learningPaths).values([
    { personalWorkspaceId: learnerSpace.id, title: 'Personal Rust' },
    { personalWorkspaceId: learnerSpace.id, title: 'Personal Guitar' },
    { personalWorkspaceId: peerSpace.id, title: 'Peer Notes' },
  ]).returning()
  const [skillA, skillB, otherSkill, peerSkill] = await db.insert(skills).values([
    { learningPathId: main.id }, { learningPathId: main.id }, { learningPathId: other.id }, { learningPathId: peers.id },
  ]).returning()
  const [taskA, taskA2, taskB, otherTask, peerTask] = await db.insert(tasks).values([
    { skillId: skillA.id }, { skillId: skillA.id }, { skillId: skillB.id }, { skillId: otherSkill.id }, { skillId: peerSkill.id },
  ]).returning()
  const skill = (s: typeof skillA, workspaceId: string, title: string, xpThreshold = 0) => ({ skillId: s.id, learningPathId: s.learningPathId, personalWorkspaceId: workspaceId, title, learningOutcome: `${title} outcome`, xpThreshold })
  await db.insert(personalSkills).values([
    skill(skillA, learnerSpace.id, 'Ownership'), skill(skillB, learnerSpace.id, 'Lifetimes', 20),
    skill(otherSkill, learnerSpace.id, 'Chords'), skill(peerSkill, peerSpace.id, 'Peer skill'),
  ])
  const task = (t: typeof taskA, s: typeof skillA, title: string, xpReward: number) => ({ taskId: t.id, skillId: s.id, learningPathId: s.learningPathId, title, xpReward })
  await db.insert(personalTasks).values([
    task(taskA, skillA, 'Borrow checker exercises', 20), task(taskA2, skillA, 'Read the ownership chapter', 10),
    task(taskB, skillB, 'Annotate lifetimes', 5), task(otherTask, otherSkill, 'Practise chord changes', 100),
    task(peerTask, peerSkill, 'Peer task', 30),
  ])
  await db.insert(personalPrerequisites).values({ learningPathId: main.id, prerequisiteSkillId: skillA.id, skillId: skillB.id })
  return {
    workspaces: { learnerSpace, peerSpace },
    paths: { main, other, peers },
    skills: { skillA, skillB, otherSkill, peerSkill },
    tasks: { taskA, taskA2, taskB, otherTask, peerTask },
  }
}

export type PersonalFixture = Awaited<ReturnType<typeof seedPersonalFixture>>
