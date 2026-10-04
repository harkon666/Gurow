import { type SQL, sql } from 'drizzle-orm'
import type { Database } from './client'

/**
 * The database time of a transition, read once after the caller holds its locks
 * and reused for every record that transition writes. Unlike `now()` (transaction
 * start, possibly before a lock wait) it follows the accepted lock order, and
 * keeping it as SQL text preserves PostgreSQL's microsecond precision.
 */
export async function lockedTimestamp(tx: Pick<Database, 'execute'>): Promise<SQL> {
  const [row] = await tx.execute<{ at: string }>(sql`select clock_timestamp()::text as at`)
  return sql`${row.at}::timestamptz`
}
