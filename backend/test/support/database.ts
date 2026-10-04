import { SQL } from 'bun'
import { sql } from 'drizzle-orm'
import { createDatabase, type Database } from '../../src/db/client'
import { migrateDatabase } from '../../src/db/migrate'

/** The separate test database from backend/.env (ADR 0021); never the development database. */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://gurow:gurow@127.0.0.1:5433/gurow_test'

/** Creates the test database when missing, then applies the committed migrations. */
export async function prepareTestDatabase(): Promise<{ db: Database; close: () => Promise<void> }> {
  const url = new URL(TEST_DATABASE_URL)
  const name = url.pathname.slice(1)
  if (!/^[a-z_][a-z0-9_]*$/.test(name) || !name.endsWith('_test')) throw new Error(`Refusing to use ${name} as a test database`)
  const admin = new SQL({ url: Object.assign(new URL(url), { pathname: '/postgres' }).toString(), max: 1 })
  try {
    const [exists] = await admin`select 1 from pg_database where datname = ${name}`
    if (!exists) await admin.unsafe(`create database ${name}`)
  } finally {
    await admin.close()
  }
  await migrateDatabase(TEST_DATABASE_URL)
  return createDatabase(TEST_DATABASE_URL)
}

/** Empties every domain table so each test starts from its own fixture. */
export async function resetTestDatabase(db: Database): Promise<void> {
  await db.execute(sql`truncate submission_reviews, submission_revisions, submissions, submission_drafts, version_prerequisites, enrollments, enrollment_invitations, version_tasks, version_skills, tasks, skills, learning_path_versions, learning_paths, coach_workspaces, auth_verifications, accounts restart identity cascade`)
}
