import { sql } from 'drizzle-orm'
import { boolean, foreignKey, integer, pgEnum, pgTable, primaryKey, text, timestamp, unique, uuid, uniqueIndex } from 'drizzle-orm/pg-core'

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
}, (t) => [primaryKey({ columns: [t.learningPathVersionId, t.skillId] })])

/** A Task's definition in one Learning Path Version, under its Skill's definition in that Version. */
export const versionTasks = pgTable('version_tasks', {
  learningPathVersionId: uuid('learning_path_version_id').notNull(),
  taskId: uuid('task_id').notNull(),
  skillId: uuid('skill_id').notNull(),
  title: text('title').notNull(),
  /** Required Task: mandatory evidence for Mastery of its Skill; otherwise an Enrichment Task. */
  required: boolean('required').notNull(),
}, (t) => [
  primaryKey({ columns: [t.learningPathVersionId, t.taskId] }),
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
}, (t) => [unique('enrollments_account_version_key').on(t.accountId, t.learningPathVersionId)])
