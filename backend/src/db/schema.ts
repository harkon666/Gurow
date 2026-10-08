import { sql } from 'drizzle-orm'
import { type AnyPgColumn, boolean, check, doublePrecision, foreignKey, index, integer, pgEnum, pgTable, primaryKey, text, timestamp, unique, uuid, uniqueIndex } from 'drizzle-orm/pg-core'

/**
 * An identity usable for personal learning and contextual Coach and Learner roles
 * (CONTEXT.md). It is also Better Auth's user model (ADR 0022), so it has no
 * Coach/Learner type: authority is checked per action and context.
 */
export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().default(''),
  email: text('email').notNull(),
  /**
   * Set only by the identity integration after the address proves itself; only a
   * verified email can redeem an Enrollment Invitation. Clients cannot write it.
   */
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('accounts_email_lower_key').on(sql`lower(${t.email})`)])

/** The ownership and management-authority boundary for coach-mode Learning Paths; one owning Coach in the MVP. */
export const coachWorkspaces = pgTable('coach_workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerAccountId: uuid('owner_account_id').notNull().references(() => accounts.id),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/** An Account's one owner-only private learning space (ADR 0012). */
export const personalWorkspaces = pgTable('personal_workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerAccountId: uuid('owner_account_id').notNull().references(() => accounts.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique('personal_workspaces_owner_key').on(t.ownerAccountId)])

/**
 * One Learning Path concept for both modes: a coach-mode Path belongs to exactly
 * one Coach Workspace, a personal-mode Path to exactly one Personal Workspace.
 */
export const learningPaths = pgTable('learning_paths', {
  id: uuid('id').primaryKey().defaultRandom(),
  coachWorkspaceId: uuid('coach_workspace_id').references(() => coachWorkspaces.id),
  personalWorkspaceId: uuid('personal_workspace_id').references(() => personalWorkspaces.id),
  /**
   * A personal Path's title and goal. A coach-mode Path keeps here only the values
   * it was created with; its title and goal belong to each Version ({@link learningPathVersions}).
   */
  title: text('title').notNull(),
  /** The goal the Path's Skills work toward (CONTEXT.md: Learning Path). */
  goal: text('goal').notNull().default(''),
  /**
   * Concurrency revision of the Path's editable content, the expected revision of
   * every content save (ADR 0016). Distinct from a Learning Path Version and from
   * the editor snapshot's format version.
   */
  revision: integer('revision').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('learning_paths_revision_nonnegative', sql`${t.revision} >= 0`),
  check('learning_paths_one_workspace', sql`num_nonnulls(${t.coachWorkspaceId}, ${t.personalWorkspaceId}) = 1`),
  // Lets personal definitions require a personal-mode Path.
  unique('learning_paths_id_personal_workspace_key').on(t.id, t.personalWorkspaceId),
])

/**
 * A published, immutable edition of a Learning Path, or its one unpublished Draft.
 * `enrollmentClosedAt` is an Enrollment Closure, independent of publication.
 */
export const learningPathVersions = pgTable('learning_path_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  learningPathId: uuid('learning_path_id').notNull().references(() => learningPaths.id),
  versionNumber: integer('version_number').notNull(),
  /**
   * The Path's title and goal as this Version states them, frozen with the rest of
   * its content once published (ADR 0005). A coach-mode Path is read through its
   * Versions, never through `learning_paths.title`/`goal`.
   */
  title: text('title').notNull(),
  goal: text('goal').notNull().default(''),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  enrollmentClosedAt: timestamp('enrollment_closed_at', { withTimezone: true }),
  /**
   * Concurrency revision of a published Version's shared Canvas Layout, the expected
   * revision of every layout save (ADR 0016). Layout saves change only card positions,
   * so they neither create a Version nor touch the Path's content `revision`; a Draft's
   * layout is saved with the Draft instead.
   */
  layoutRevision: integer('layout_revision').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('learning_path_versions_path_number_key').on(t.learningPathId, t.versionNumber),
  check('learning_path_versions_layout_revision_nonnegative', sql`${t.layoutRevision} >= 0`),
  // An unpublished Version is the Path's Learning Path Draft: at most one per Path.
  uniqueIndex('learning_path_versions_one_draft_key').on(t.learningPathId).where(sql`${t.publishedAt} IS NULL`),
])

/**
 * A Skill's logical identity, stable across the Versions of its one Learning
 * Path (ADR 0004). Its definition lives in {@link versionSkills}.
 */
export const skills = pgTable('skills', {
  id: uuid('id').primaryKey().defaultRandom(),
  learningPathId: uuid('learning_path_id').notNull().references(() => learningPaths.id),
}, (t) => [unique('skills_id_learning_path_key').on(t.id, t.learningPathId)])

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
  /** Optional Skill: enrichment a learner may skip; it must not be a Prerequisite of a required Skill. */
  optional: boolean('optional').notNull().default(false),
  /** Position in the Version's Skill list, as last saved by the Coach. */
  ordinal: integer('ordinal').notNull().default(0),
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
  description: text('description').notNull().default(''),
  /** Position in its Skill's Task list, as last saved by the Coach. */
  ordinal: integer('ordinal').notNull().default(0),
}, (t) => [
  primaryKey({ columns: [t.learningPathVersionId, t.taskId] }),
  check('version_tasks_xp_reward_nonnegative', sql`${t.xpReward} >= 0`),
  // The definition sits under the Skill that owns the Task.
  foreignKey({ columns: [t.taskId, t.skillId], foreignColumns: [tasks.id, tasks.skillId] }),
  foreignKey({ columns: [t.learningPathVersionId, t.skillId], foreignColumns: [versionSkills.learningPathVersionId, versionSkills.skillId] }),
])

/**
 * The one flat, manually positioned card of a Skill in one Version: that Version's
 * Canvas Layout, kept apart from its learning content (ADR 0005, 0015).
 */
export const versionSkillCards = pgTable('version_skill_cards', {
  learningPathVersionId: uuid('learning_path_version_id').notNull(),
  skillId: uuid('skill_id').notNull(),
  x: doublePrecision('x').notNull(),
  y: doublePrecision('y').notNull(),
}, (t) => [
  primaryKey({ name: 'version_skill_cards_pk', columns: [t.learningPathVersionId, t.skillId] }),
  foreignKey({ name: 'version_skill_cards_skill_fk', columns: [t.learningPathVersionId, t.skillId], foreignColumns: [versionSkills.learningPathVersionId, versionSkills.skillId] }),
  check('version_skill_cards_bounds', sql`abs(${t.x}) <= 1000000 AND abs(${t.y}) <= 1000000`),
])

/**
 * What happened to the email carrying an Invitation on its last attempt (ADR 0023):
 * `sent` only when the email provider accepted it; `logged` when no provider is
 * configured and the link was only written to the server log, so nothing left.
 */
export const invitationDeliveryStatus = pgEnum('invitation_delivery_status', ['pending', 'sent', 'logged', 'failed'])

/**
 * An offer to join exactly one published Version, addressed to one email. It has
 * no expiry: none was agreed (SPEC). Delivery state records only whether the email
 * provider accepted the message; it never affects who may accept.
 */
export const enrollmentInvitations = pgTable('enrollment_invitations', {
  id: uuid('id').primaryKey().defaultRandom(),
  learningPathVersionId: uuid('learning_path_version_id').notNull().references(() => learningPathVersions.id),
  email: text('email').notNull(),
  invitedByAccountId: uuid('invited_by_account_id').notNull().references(() => accounts.id),
  /** First successful acceptance; repeated acceptance keeps it. */
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  deliveryStatus: invitationDeliveryStatus('delivery_status').notNull().default('pending'),
  /** Delivery attempts started, each with its own provider idempotency key. */
  deliveryAttempts: integer('delivery_attempts').notNull().default(0),
  /** Last time the provider accepted the email. */
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('enrollment_invitations_version_idx').on(t.learningPathVersionId)])

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

/**
 * A Skill's editable definition in a personal-mode Path (unversioned). Mastery is
 * the owner's free declaration: no evidence, Review or Task completion sets it.
 */
export const personalSkills = pgTable('personal_skills', {
  skillId: uuid('skill_id').primaryKey(),
  learningPathId: uuid('learning_path_id').notNull(),
  personalWorkspaceId: uuid('personal_workspace_id').notNull(),
  title: text('title').notNull(),
  learningOutcome: text('learning_outcome').notNull(),
  xpThreshold: integer('xp_threshold').notNull().default(0),
  masteryDeclaredAt: timestamp('mastery_declared_at', { withTimezone: true }),
  /** Position in the Path's Skill list, as last saved by the owner. */
  ordinal: integer('ordinal').notNull().default(0),
}, (t) => [
  unique('personal_skills_path_skill_key').on(t.learningPathId, t.skillId),
  foreignKey({ columns: [t.skillId, t.learningPathId], foreignColumns: [skills.id, skills.learningPathId] }),
  foreignKey({ columns: [t.learningPathId, t.personalWorkspaceId], foreignColumns: [learningPaths.id, learningPaths.personalWorkspaceId] }),
  check('personal_skills_xp_threshold_nonnegative', sql`${t.xpThreshold} >= 0`),
])

/**
 * A personal Task's editable definition and completion state. A completed Task
 * contributes its current `xpReward`; an incomplete one contributes zero. Archival
 * is one-way here and keeps the contribution.
 */
export const personalTasks = pgTable('personal_tasks', {
  taskId: uuid('task_id').primaryKey(),
  learningPathId: uuid('learning_path_id').notNull(),
  skillId: uuid('skill_id').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  /** Position in its Skill's Task list, as last saved by the owner. */
  ordinal: integer('ordinal').notNull().default(0),
  xpReward: integer('xp_reward').notNull().default(0),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
}, (t) => [
  unique('personal_tasks_path_task_key').on(t.learningPathId, t.taskId),
  foreignKey({ columns: [t.taskId, t.skillId], foreignColumns: [tasks.id, tasks.skillId] }),
  foreignKey({ columns: [t.learningPathId, t.skillId], foreignColumns: [personalSkills.learningPathId, personalSkills.skillId] }),
  check('personal_tasks_xp_reward_nonnegative', sql`${t.xpReward} >= 0`),
])

/**
 * The one flat, manually positioned card of a personal Skill: the Path's Canvas
 * Layout, kept apart from its learning definitions (ADR 0015, 0016). Camera,
 * selection and undo history are never stored here.
 */
export const personalSkillCards = pgTable('personal_skill_cards', {
  learningPathId: uuid('learning_path_id').notNull(),
  skillId: uuid('skill_id').notNull(),
  x: doublePrecision('x').notNull(),
  y: doublePrecision('y').notNull(),
}, (t) => [
  primaryKey({ name: 'personal_skill_cards_pk', columns: [t.learningPathId, t.skillId] }),
  foreignKey({ name: 'personal_skill_cards_skill_fk', columns: [t.learningPathId, t.skillId], foreignColumns: [personalSkills.learningPathId, personalSkills.skillId] }),
  check('personal_skill_cards_bounds', sql`abs(${t.x}) <= 1000000 AND abs(${t.y}) <= 1000000`),
])

/**
 * A personal Skill's Task Board (ADR 0027): its ordered columns and card membership,
 * kept apart from the Path document. `revision` is the expected revision of every
 * board save (ADR 0016), independent of the Path's content revision. A Skill has no
 * row until its board is first opened; that opening places its existing Tasks once.
 */
export const personalTaskBoards = pgTable('personal_task_boards', {
  learningPathId: uuid('learning_path_id').notNull(),
  skillId: uuid('skill_id').notNull(),
  revision: integer('revision').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ name: 'personal_task_boards_pk', columns: [t.learningPathId, t.skillId] }),
  foreignKey({ name: 'personal_task_boards_skill_fk', columns: [t.learningPathId, t.skillId], foreignColumns: [personalSkills.learningPathId, personalSkills.skillId] }),
  check('personal_task_boards_revision_nonnegative', sql`${t.revision} >= 0`),
])

/**
 * A Task Board Column. Its identity and `completion` role, not its user-chosen name,
 * decide what membership means: exactly one column per board is the Completion Column.
 */
export const personalBoardColumns = pgTable('personal_board_columns', {
  id: uuid('id').primaryKey(),
  learningPathId: uuid('learning_path_id').notNull(),
  skillId: uuid('skill_id').notNull(),
  name: text('name').notNull(),
  completion: boolean('completion').notNull().default(false),
  position: integer('position').notNull(),
}, (t) => [
  unique('personal_board_columns_id_board_key').on(t.id, t.learningPathId, t.skillId),
  unique('personal_board_columns_position_key').on(t.learningPathId, t.skillId, t.position),
  uniqueIndex('personal_board_columns_one_completion_key').on(t.learningPathId, t.skillId).where(sql`${t.completion}`),
  foreignKey({ name: 'personal_board_columns_board_fk', columns: [t.learningPathId, t.skillId], foreignColumns: [personalTaskBoards.learningPathId, personalTaskBoards.skillId] }),
  check('personal_board_columns_name', sql`length(trim(${t.name})) > 0 AND length(${t.name}) <= 60`),
])

/**
 * One active Task's card: the column it sits in and its place there. The card refers
 * to the Task and never copies its learning records; the foreign keys keep it on its
 * own Skill's board. A deferred trigger (migration 0016) keeps membership of the
 * Completion Column equal to the Task's completion and keeps archived Tasks off boards.
 */
export const personalBoardCards = pgTable('personal_board_cards', {
  learningPathId: uuid('learning_path_id').notNull(),
  skillId: uuid('skill_id').notNull(),
  taskId: uuid('task_id').notNull(),
  columnId: uuid('column_id').notNull(),
  position: integer('position').notNull(),
}, (t) => [
  primaryKey({ name: 'personal_board_cards_pk', columns: [t.learningPathId, t.taskId] }),
  unique('personal_board_cards_position_key').on(t.columnId, t.position),
  foreignKey({ name: 'personal_board_cards_task_fk', columns: [t.learningPathId, t.taskId], foreignColumns: [personalTasks.learningPathId, personalTasks.taskId] }),
  foreignKey({ name: 'personal_board_cards_task_skill_fk', columns: [t.taskId, t.skillId], foreignColumns: [tasks.id, tasks.skillId] }),
  foreignKey({ name: 'personal_board_cards_column_fk', columns: [t.columnId, t.learningPathId, t.skillId], foreignColumns: [personalBoardColumns.id, personalBoardColumns.learningPathId, personalBoardColumns.skillId] }),
])

/**
 * A Coach's preparation board for one Skill of a Learning Path Draft (ADR 0027, 0029):
 * ordered columns of the Draft's Tasks expressing material readiness, kept apart from
 * the Draft's content. It belongs to the Draft (an unpublished Version), so publication
 * freezes it with the Version (migration 0017) and the next Draft starts its own board.
 * `revision` is the expected revision of every board save, independent of the Path's.
 */
export const draftTaskBoards = pgTable('draft_task_boards', {
  learningPathVersionId: uuid('learning_path_version_id').notNull(),
  skillId: uuid('skill_id').notNull(),
  revision: integer('revision').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ name: 'draft_task_boards_pk', columns: [t.learningPathVersionId, t.skillId] }),
  foreignKey({ name: 'draft_task_boards_skill_fk', columns: [t.learningPathVersionId, t.skillId], foreignColumns: [versionSkills.learningPathVersionId, versionSkills.skillId] }),
  check('draft_task_boards_revision_nonnegative', sql`${t.revision} >= 0`),
])

/** A preparation column: a user-named readiness grouping with no learning role. */
export const draftBoardColumns = pgTable('draft_board_columns', {
  id: uuid('id').primaryKey(),
  learningPathVersionId: uuid('learning_path_version_id').notNull(),
  skillId: uuid('skill_id').notNull(),
  name: text('name').notNull(),
  position: integer('position').notNull(),
}, (t) => [
  unique('draft_board_columns_id_board_key').on(t.id, t.learningPathVersionId, t.skillId),
  unique('draft_board_columns_position_key').on(t.learningPathVersionId, t.skillId, t.position),
  foreignKey({ name: 'draft_board_columns_board_fk', columns: [t.learningPathVersionId, t.skillId], foreignColumns: [draftTaskBoards.learningPathVersionId, draftTaskBoards.skillId] }),
  check('draft_board_columns_name', sql`length(trim(${t.name})) > 0 AND length(${t.name}) <= 60`),
])

/**
 * One Draft Task's card. It refers to the Task's definition in this Draft, so a Task
 * leaves the board before it leaves the Draft, and never copies anything from it.
 */
export const draftBoardCards = pgTable('draft_board_cards', {
  learningPathVersionId: uuid('learning_path_version_id').notNull(),
  skillId: uuid('skill_id').notNull(),
  taskId: uuid('task_id').notNull(),
  columnId: uuid('column_id').notNull(),
  position: integer('position').notNull(),
}, (t) => [
  primaryKey({ name: 'draft_board_cards_pk', columns: [t.learningPathVersionId, t.taskId] }),
  unique('draft_board_cards_position_key').on(t.columnId, t.position),
  foreignKey({ name: 'draft_board_cards_task_fk', columns: [t.learningPathVersionId, t.taskId], foreignColumns: [versionTasks.learningPathVersionId, versionTasks.taskId] }),
  foreignKey({ name: 'draft_board_cards_task_skill_fk', columns: [t.taskId, t.skillId], foreignColumns: [tasks.id, tasks.skillId] }),
  foreignKey({ name: 'draft_board_cards_column_fk', columns: [t.columnId, t.learningPathVersionId, t.skillId], foreignColumns: [draftBoardColumns.id, draftBoardColumns.learningPathVersionId, draftBoardColumns.skillId] }),
])

/** ALL prerequisite edges within one personal Path, satisfied by declared Mastery. */
export const personalPrerequisites = pgTable('personal_prerequisites', {
  learningPathId: uuid('learning_path_id').notNull(),
  prerequisiteSkillId: uuid('prerequisite_skill_id').notNull(),
  skillId: uuid('skill_id').notNull(),
}, (t) => [
  primaryKey({ name: 'personal_prerequisites_pk', columns: [t.learningPathId, t.prerequisiteSkillId, t.skillId] }),
  foreignKey({ name: 'personal_prerequisites_source_fk', columns: [t.learningPathId, t.prerequisiteSkillId], foreignColumns: [personalSkills.learningPathId, personalSkills.skillId] }),
  foreignKey({ name: 'personal_prerequisites_target_fk', columns: [t.learningPathId, t.skillId], foreignColumns: [personalSkills.learningPathId, personalSkills.skillId] }),
  check('personal_prerequisites_no_self_edge', sql`${t.prerequisiteSkillId} <> ${t.skillId}`),
])

/**
 * Append-only XP Award/Correction history of one personal Path. `cause` names
 * the owner action; the signed amount is the change in the Task's contribution.
 */
export const personalXpEvents = pgTable('personal_xp_events', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  learningPathId: uuid('learning_path_id').notNull(),
  taskId: uuid('task_id').notNull(),
  actorAccountId: uuid('actor_account_id').notNull().references(() => accounts.id),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  kind: text('kind').notNull(),
  cause: text('cause').notNull(),
  amount: integer('amount').notNull(),
}, (t) => [
  foreignKey({ columns: [t.learningPathId, t.taskId], foreignColumns: [personalTasks.learningPathId, personalTasks.taskId] }),
  check('personal_xp_events_kind', sql`${t.kind} IN ('award', 'correction')`),
  check('personal_xp_events_cause', sql`${t.cause} IN ('completion', 'completion_undone', 'reward_change')`),
  check('personal_xp_events_nonzero', sql`${t.amount} <> 0`),
])

/** Append-only history of the owner's Mastery declarations and withdrawals. */
export const personalMasteryEvents = pgTable('personal_mastery_events', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  learningPathId: uuid('learning_path_id').notNull(),
  skillId: uuid('skill_id').notNull(),
  actorAccountId: uuid('actor_account_id').notNull().references(() => accounts.id),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  action: text('action').notNull(),
}, (t) => [
  foreignKey({ columns: [t.learningPathId, t.skillId], foreignColumns: [personalSkills.learningPathId, personalSkills.skillId] }),
  check('personal_mastery_events_action', sql`${t.action} IN ('declare', 'withdraw')`),
])

/** Append-only personal Access Overrides; the latest record per Skill is current. No reason is required. */
export const personalOverrideRecords = pgTable('personal_override_records', {
  id: uuid('id').primaryKey().defaultRandom(),
  sequence: integer('sequence').notNull().generatedAlwaysAsIdentity(),
  learningPathId: uuid('learning_path_id').notNull(),
  skillId: uuid('skill_id').notNull(),
  actorAccountId: uuid('actor_account_id').notNull().references(() => accounts.id),
  action: text('action').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
}, (t) => [
  unique('personal_override_records_sequence_key').on(t.sequence),
  foreignKey({ columns: [t.learningPathId, t.skillId], foreignColumns: [personalSkills.learningPathId, personalSkills.skillId] }),
  check('personal_override_records_action', sql`${t.action} IN ('grant', 'revoke')`),
])

/** A signed-in browser session of one Account, issued by Better Auth (ADR 0022). */
export const authSessions = pgTable('auth_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('auth_sessions_account_idx').on(t.userId)])

/**
 * How an Account signs in: Better Auth's "account" model, renamed so it is not
 * confused with the domain Account. The email/password credential stores only a hash.
 */
export const authCredentials = pgTable('auth_credentials', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  accountId: text('provider_account_id').notNull(),
  providerId: text('provider_id').notNull(),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('auth_credentials_account_idx').on(t.userId),
  unique('auth_credentials_provider_key').on(t.providerId, t.accountId),
])

/** Short-lived identity proofs such as email verification tokens. */
export const authVerifications = pgTable('auth_verifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('auth_verifications_identifier_idx').on(t.identifier)])
