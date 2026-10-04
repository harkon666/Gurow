import { sql } from 'drizzle-orm'
import { type AnyPgColumn, boolean, check, foreignKey, integer, pgEnum, pgTable, primaryKey, text, timestamp, unique, uuid, uniqueIndex } from 'drizzle-orm/pg-core'

/** An identity usable for personal learning and contextual Coach and Learner roles (CONTEXT.md). */
export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull(),
  /** Null until the email is verified; only a verified email can redeem an Enrollment Invitation. */
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('accounts_email_lower_key').on(sql`lower(${t.email})`)])

/** The ownership and management-authority boundary for coach-mode Learning Paths; one owning Coach in the MVP. */
export const coachWorkspaces = pgTable('coach_workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerAccountId: uuid('owner_account_id').notNull().references(() => accounts.id),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/** A coach-mode Learning Path, owned by exactly one Coach Workspace. */
export const learningPaths = pgTable('learning_paths', {
  id: uuid('id').primaryKey().defaultRandom(),
  coachWorkspaceId: uuid('coach_workspace_id').notNull().references(() => coachWorkspaces.id),
  title: text('title').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * A published, immutable edition of a Learning Path. `enrollmentClosedAt` is an
 * Enrollment Closure, independent of publication.
 */
export const learningPathVersions = pgTable('learning_path_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  learningPathId: uuid('learning_path_id').notNull().references(() => learningPaths.id),
  versionNumber: integer('version_number').notNull(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  enrollmentClosedAt: timestamp('enrollment_closed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique('learning_path_versions_path_number_key').on(t.learningPathId, t.versionNumber)])

/**
 * A Skill's logical identity, stable across the Versions of its one Learning
 * Path (ADR 0004). Its definition lives in {@link versionSkills}.
 */
export const skills = pgTable('skills', {
  id: uuid('id').primaryKey().defaultRandom(),
  learningPathId: uuid('learning_path_id').notNull().references(() => learningPaths.id),
})

/** A Task's logical identity, owned by exactly one Skill (ADR 0004). */
export const tasks = pgTable('tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  skillId: uuid('skill_id').notNull().references(() => skills.id),
}, (t) => [unique('tasks_id_skill_key').on(t.id, t.skillId)])

/** A Skill's definition in one Learning Path Version. */
export const versionSkills = pgTable('version_skills', {
  learningPathVersionId: uuid('learning_path_version_id').notNull().references(() => learningPathVersions.id),
  skillId: uuid('skill_id').notNull().references(() => skills.id),
  title: text('title').notNull(),
  learningOutcome: text('learning_outcome').notNull(),
  xpThreshold: integer('xp_threshold').notNull().default(0),
}, (t) => [
  primaryKey({ columns: [t.learningPathVersionId, t.skillId] }),
  check('version_skills_xp_threshold_nonnegative', sql`${t.xpThreshold} >= 0`),
])

/** ALL prerequisite edges, with both ends defined in the same pinned Version. */
export const versionPrerequisites = pgTable('version_prerequisites', {
  learningPathVersionId: uuid('learning_path_version_id').notNull(),
  prerequisiteSkillId: uuid('prerequisite_skill_id').notNull(),
  skillId: uuid('skill_id').notNull(),
}, (t) => [
  primaryKey({ name: 'version_prerequisites_pk', columns: [t.learningPathVersionId, t.prerequisiteSkillId, t.skillId] }),
  foreignKey({ name: 'version_prerequisites_source_fk', columns: [t.learningPathVersionId, t.prerequisiteSkillId], foreignColumns: [versionSkills.learningPathVersionId, versionSkills.skillId] }),
  foreignKey({ name: 'version_prerequisites_target_fk', columns: [t.learningPathVersionId, t.skillId], foreignColumns: [versionSkills.learningPathVersionId, versionSkills.skillId] }),
  check('version_prerequisites_no_self_edge', sql`${t.prerequisiteSkillId} <> ${t.skillId}`),
])

/** A Task's definition in one Learning Path Version, under its Skill's definition in that Version. */
export const versionTasks = pgTable('version_tasks', {
  learningPathVersionId: uuid('learning_path_version_id').notNull(),
  taskId: uuid('task_id').notNull(),
  skillId: uuid('skill_id').notNull(),
  title: text('title').notNull(),
  /** Required Task: mandatory evidence for Mastery of its Skill; otherwise an Enrichment Task. */
  required: boolean('required').notNull(),
  xpReward: integer('xp_reward').notNull().default(0),
}, (t) => [
  primaryKey({ columns: [t.learningPathVersionId, t.taskId] }),
  check('version_tasks_xp_reward_nonnegative', sql`${t.xpReward} >= 0`),
  // The definition sits under the Skill that owns the Task.
  foreignKey({ columns: [t.taskId, t.skillId], foreignColumns: [tasks.id, tasks.skillId] }),
  foreignKey({ columns: [t.learningPathVersionId, t.skillId], foreignColumns: [versionSkills.learningPathVersionId, versionSkills.skillId] }),
])

/** An offer to join exactly one published Version, addressed to one email. */
export const enrollmentInvitations = pgTable('enrollment_invitations', {
  id: uuid('id').primaryKey().defaultRandom(),
  learningPathVersionId: uuid('learning_path_version_id').notNull().references(() => learningPathVersions.id),
  email: text('email').notNull(),
  invitedByAccountId: uuid('invited_by_account_id').notNull().references(() => accounts.id),
  /** First successful acceptance; repeated acceptance keeps it. */
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const enrollmentStatus = pgEnum('enrollment_status', ['active', 'inactive'])

/**
 * A learner's participation in one Learning Path Version, and the context its
 * XP is scoped to (ADR 0007). At most one per Account and Version (ADR 0005).
 */
export const enrollments = pgTable('enrollments', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull().references(() => accounts.id),
  learningPathVersionId: uuid('learning_path_version_id').notNull().references(() => learningPathVersions.id),
  status: enrollmentStatus('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('enrollments_account_version_key').on(t.accountId, t.learningPathVersionId),
  // Lets learner work reference the Enrollment together with its pinned Version.
  unique('enrollments_id_version_key').on(t.id, t.learningPathVersionId),
])

/**
 * A learner's saved, editable work for one Task in one Enrollment, visible only
 * to that learner (ADR 0002). Sending does not consume it.
 */
export const submissionDrafts = pgTable('submission_drafts', {
  enrollmentId: uuid('enrollment_id').notNull(),
  learningPathVersionId: uuid('learning_path_version_id').notNull(),
  taskId: uuid('task_id').notNull(),
  text: text('text').notNull(),
  urls: text('urls').array().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.enrollmentId, t.taskId] }),
  foreignKey({ columns: [t.enrollmentId, t.learningPathVersionId], foreignColumns: [enrollments.id, enrollments.learningPathVersionId] }),
  // The Task is defined in the Enrollment's own Version.
  foreignKey({ columns: [t.learningPathVersionId, t.taskId], foreignColumns: [versionTasks.learningPathVersionId, versionTasks.taskId] }),
])

/**
 * Learner work sent for review for exactly one Task: at most one per Task and
 * Enrollment, holding successive Submission Revisions (ADR 0002).
 */
export const submissions = pgTable('submissions', {
  id: uuid('id').primaryKey().defaultRandom(),
  enrollmentId: uuid('enrollment_id').notNull(),
  learningPathVersionId: uuid('learning_path_version_id').notNull(),
  taskId: uuid('task_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('submissions_enrollment_task_key').on(t.enrollmentId, t.taskId),
  foreignKey({ columns: [t.enrollmentId, t.learningPathVersionId], foreignColumns: [enrollments.id, enrollments.learningPathVersionId] }),
  foreignKey({ columns: [t.learningPathVersionId, t.taskId], foreignColumns: [versionTasks.learningPathVersionId, versionTasks.taskId] }),
])

/**
 * Immutable contents of one sending: text and URLs exactly as sent, not the
 * content at those URLs. A database trigger rejects changes to sent contents;
 * only `supersededAt` can be set, once, when a newer revision supersedes an
 * undecided one.
 */
export const submissionRevisions = pgTable('submission_revisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  submissionId: uuid('submission_id').notNull().references(() => submissions.id),
  revisionNumber: integer('revision_number').notNull(),
  text: text('text').notNull(),
  urls: text('urls').array().notNull(),
  sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  supersededAt: timestamp('superseded_at', { withTimezone: true }),
}, (t) => [unique('submission_revisions_submission_number_key').on(t.submissionId, t.revisionNumber)])

export const reviewDecision = pgEnum('review_decision', ['approval', 'changes_requested'])

/**
 * Durable, revision-specific decision. Review and future revocation mutators
 * lock the target Enrollment FOR UPDATE before reading or changing progression,
 * retaining it through commit (see recordReview and sendRevision).
 */
export const submissionReviews = pgTable('submission_reviews', {
  revisionId: uuid('revision_id').primaryKey().references(() => submissionRevisions.id),
  coachAccountId: uuid('coach_account_id').notNull().references(() => accounts.id),
  decision: reviewDecision('decision').notNull(),
  feedback: text('feedback'),
  decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revocationReason: text('revocation_reason'),
  revokedByAccountId: uuid('revoked_by_account_id').references(() => accounts.id),
}, (t) => [
  check('submission_reviews_changes_feedback', sql`${t.decision} <> 'changes_requested' OR length(trim(${t.feedback})) > 0 AND ${t.feedback} IS NOT NULL`),
  check('submission_reviews_revocation', sql`(${t.revokedAt} IS NULL AND ${t.revocationReason} IS NULL) OR (${t.decision} = 'approval' AND ${t.revokedAt} IS NOT NULL AND ${t.revocationReason} IS NOT NULL AND length(trim(${t.revocationReason})) > 0)`),
])

/** Append-only Override Records. The latest record per Enrollment/Skill is the
 * current exception; revocation names the exact grant, preventing stale withdrawal.
 * All writers/readers hold the Enrollment lock. SQL rejects audit update/delete.
 */
export const overrideRecords = pgTable('override_records', {
  id: uuid('id').primaryKey().defaultRandom(),
  sequence: integer('sequence').notNull().generatedAlwaysAsIdentity(),
  enrollmentId: uuid('enrollment_id').notNull(),
  learningPathVersionId: uuid('learning_path_version_id').notNull(),
  skillId: uuid('skill_id').notNull(),
  coachAccountId: uuid('coach_account_id').notNull().references(() => accounts.id),
  learnerAccountId: uuid('learner_account_id').notNull().references(() => accounts.id),
  action: text('action').notNull(),
  grantRecordId: uuid('grant_record_id').references((): AnyPgColumn => overrideRecords.id),
  reason: text('reason').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('override_records_sequence_key').on(t.sequence),
  foreignKey({ columns: [t.enrollmentId, t.learningPathVersionId], foreignColumns: [enrollments.id, enrollments.learningPathVersionId] }),
  foreignKey({ columns: [t.learningPathVersionId, t.skillId], foreignColumns: [versionSkills.learningPathVersionId, versionSkills.skillId] }),
  check('override_records_action', sql`(${t.action} = 'grant' AND ${t.grantRecordId} IS NULL) OR (${t.action} = 'revoke' AND ${t.grantRecordId} IS NOT NULL)`),
  check('override_records_reason', sql`length(trim(${t.reason})) > 0 AND length(${t.reason}) <= 500`),
])

/** Append-only participation audit, independent of progress and Access Overrides. */
export const enrollmentLifecycleRecords = pgTable('enrollment_lifecycle_records', {
  id: uuid('id').primaryKey().defaultRandom(),
  sequence: integer('sequence').notNull().generatedAlwaysAsIdentity(),
  enrollmentId: uuid('enrollment_id').notNull(),
  learningPathVersionId: uuid('learning_path_version_id').notNull(),
  actorAccountId: uuid('actor_account_id').notNull().references(() => accounts.id),
  learnerAccountId: uuid('learner_account_id').notNull().references(() => accounts.id),
  action: text('action').notNull(),
  reason: text('reason'),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('enrollment_lifecycle_records_sequence_key').on(t.sequence),
  foreignKey({ columns: [t.enrollmentId, t.learningPathVersionId], foreignColumns: [enrollments.id, enrollments.learningPathVersionId] }),
  check('enrollment_lifecycle_records_action', sql`${t.action} IN ('deactivate', 'reactivate')`),
  check('enrollment_lifecycle_records_reason', sql`(${t.reason} IS NOT NULL AND length(trim(${t.reason})) > 0 AND length(${t.reason}) <= 500) OR (${t.reason} IS NULL AND ${t.action} = 'deactivate' AND ${t.actorAccountId} = ${t.learnerAccountId})`),
])

/** First explicit Task start; retries never reset the learner's work or start time. */
export const taskStarts = pgTable('task_starts', {
  enrollmentId: uuid('enrollment_id').notNull(),
  learningPathVersionId: uuid('learning_path_version_id').notNull(),
  taskId: uuid('task_id').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.enrollmentId, t.taskId] }),
  foreignKey({ columns: [t.enrollmentId, t.learningPathVersionId], foreignColumns: [enrollments.id, enrollments.learningPathVersionId] }),
  foreignKey({ columns: [t.learningPathVersionId, t.taskId], foreignColumns: [versionTasks.learningPathVersionId, versionTasks.taskId] }),
])

export const xpEvents = pgTable('xp_events', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  enrollmentId: uuid('enrollment_id').notNull(),
  learningPathVersionId: uuid('learning_path_version_id').notNull(),
  taskId: uuid('task_id').notNull(),
  revisionId: uuid('revision_id').notNull().references(() => submissionReviews.revisionId),
  actorAccountId: uuid('actor_account_id').references(() => accounts.id),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  kind: text('kind').notNull(),
  amount: integer('amount').notNull(),
}, (t) => [
  foreignKey({ columns: [t.enrollmentId, t.learningPathVersionId], foreignColumns: [enrollments.id, enrollments.learningPathVersionId] }),
  foreignKey({ columns: [t.learningPathVersionId, t.taskId], foreignColumns: [versionTasks.learningPathVersionId, versionTasks.taskId] }),
  check('xp_events_kind', sql`${t.kind} IN ('award', 'correction')`),
  check('xp_events_nonzero', sql`${t.amount} <> 0`),
])

export const masteryEvents = pgTable('mastery_events', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  enrollmentId: uuid('enrollment_id').notNull(),
  learningPathVersionId: uuid('learning_path_version_id').notNull(),
  skillId: uuid('skill_id').notNull(),
  revisionId: uuid('revision_id').notNull().references(() => submissionReviews.revisionId),
  actorAccountId: uuid('actor_account_id').references(() => accounts.id),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  action: text('action').notNull(),
}, (t) => [
  foreignKey({ columns: [t.enrollmentId, t.learningPathVersionId], foreignColumns: [enrollments.id, enrollments.learningPathVersionId] }),
  foreignKey({ columns: [t.learningPathVersionId, t.skillId], foreignColumns: [versionSkills.learningPathVersionId, versionSkills.skillId] }),
  check('mastery_events_action', sql`${t.action} IN ('award', 'revocation')`),
])
