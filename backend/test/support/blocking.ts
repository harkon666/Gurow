import { sql } from 'drizzle-orm'
import type { Database } from '../../src/db/client'

/**
 * Polls until PostgreSQL reports a backend waiting on `blocker` and returns that
 * backend's PID. Ordering tests use it to observe actual lock waits instead of
 * relying on request start timing; no observed wait within ~2 s fails the test.
 */
export async function waitForBlockedBy(db: Database, blocker: number, attempts = 400): Promise<number> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const rows = await db.execute<{ pid: number }>(sql`select pid from pg_stat_activity where ${blocker} = any(pg_blocking_pids(pid))`)
    if (rows.length) return rows[0].pid
    await Bun.sleep(5)
  }
  throw new Error(`No PostgreSQL-observed wait on backend ${blocker}`)
}
