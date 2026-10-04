import { SQL } from 'bun'
import { drizzle } from 'drizzle-orm/bun-sql'
import * as schema from './schema'

/** Opens a pooled connection; the driver choice is recorded in ADR 0021. */
export function createDatabase(url: string, maxConnections = 10) {
  const client = new SQL({ url, max: maxConnections })
  return { db: drizzle({ client, schema }), close: () => client.close() }
}

export type Database = ReturnType<typeof createDatabase>['db']
