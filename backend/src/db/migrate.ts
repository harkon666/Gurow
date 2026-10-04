import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createDatabase } from './client'

/** Applies the committed SQL migrations in ./drizzle to `url`. */
export async function migrateDatabase(url: string): Promise<void> {
  const { db, close } = createDatabase(url, 1)
  try {
    await migrate(db, { migrationsFolder: new URL('../../drizzle', import.meta.url).pathname })
  } finally {
    await close()
  }
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set; copy backend/.env.example to backend/.env')
  await migrateDatabase(url)
  console.log('Migrations applied')
}
