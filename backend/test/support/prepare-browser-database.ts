import { prepareTestDatabase, resetTestDatabase, TEST_DATABASE_URL } from './database'

/**
 * Creates, migrates and empties the database named by TEST_DATABASE_URL for a
 * browser integration check, which then serves the production entry point on it.
 * The `_test` suffix guard in {@link prepareTestDatabase} still applies.
 */
if (import.meta.main) {
  const { db, close } = await prepareTestDatabase()
  try {
    await resetTestDatabase(db)
  } finally {
    await close()
  }
  console.log(`Prepared ${new URL(TEST_DATABASE_URL).pathname.slice(1)}`)
}
