import type { Database } from '../../src/db/client'
import { accounts, coachWorkspaces, enrollmentInvitations, learningPaths, learningPathVersions, skills, tasks, versionSkills, versionTasks } from '../../src/db/schema'

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
  const verified = new Date('2026-10-01T00:00:00Z')
  const [coach, learner, peer, unrelated, otherCoach, unverified] = await db.insert(accounts).values([
    { email: 'coach@gurow.test', emailVerifiedAt: verified },
    { email: 'Learner@Gurow.test', emailVerifiedAt: verified },
    { email: 'peer@gurow.test', emailVerifiedAt: verified },
    { email: 'unrelated@gurow.test', emailVerifiedAt: verified },
    { email: 'other-coach@gurow.test', emailVerifiedAt: verified },
    { email: 'unverified@gurow.test', emailVerifiedAt: null },
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
  const [version1, version2, siblingVersion, closedVersion] = await db.insert(learningPathVersions).values([
    { learningPathId: path.id, versionNumber: 1, publishedAt: published },
    { learningPathId: path.id, versionNumber: 2, publishedAt: published },
    { learningPathId: siblingPath.id, versionNumber: 1, publishedAt: published },
    { learningPathId: siblingPath.id, versionNumber: 2, publishedAt: published, enrollmentClosedAt: published },
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
  for (const [version, revision] of [[version1, ''], [version2, ' (revised)']] as const) {
    const { skills: skillRows, tasks: taskRows } = content(version.id, revision)
    await db.insert(versionSkills).values(skillRows)
    await db.insert(versionTasks).values(taskRows)
  }

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
