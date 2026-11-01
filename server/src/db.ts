// Drizzle client factory + schema re-export
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export function createDb(connectionString: string) {
  const pool = new pg.Pool({ connectionString });
  // An 'error' event nobody listens for kills the process, and a Postgres restart
  // raises one on every connection. pg-pool discards the dead client and the next
  // query opens a fresh one, so logging is all these have to do. Only err.message:
  // pg-pool hangs the whole client off the error object.
  pool.on('error', (err) => console.error('pg pool idle client error:', err.message));
  // pg-pool removes its idle listener for the whole checkout, so a client inside
  // db.transaction has none of its own. This one survives checkout; the query in
  // flight still rejects, which is what fails the transaction.
  pool.on('connect', (client) => {
    client.on('error', (err) => console.error('pg client error:', err.message));
  });
  return drizzle(pool, { schema });
}

export type Db = ReturnType<typeof createDb>;
export { schema };
