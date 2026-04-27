import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
// Load .env from the server directory (not CWD which may differ)
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../.env'), override: true });

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { createDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { schema } from '../src/db.js';
import { resetRateLimiter } from '../src/middleware/rate-limit.js';

export const db = createDb(process.env.DATABASE_URL!);
export const app: Hono = createApp(db);
export { resetRateLimiter };

export async function truncateAll(): Promise<void> {
  // Delete in child-first order to avoid FK constraint violations
  await db.delete(schema.visits);
  await db.delete(schema.favorites);
  await db.delete(schema.savedLocations);
  await db.delete(schema.history);
  await db.delete(schema.accounts);
}

export async function createTestAccount(): Promise<string> {
  const res = await app.request('/api/accounts', { method: 'POST' });
  if (res.status !== 201) throw new Error(`createTestAccount failed: ${res.status}`);
  const { username } = await res.json() as { username: string };
  return username;
}

export const VISIT_BODY = {
  date: '2026-04-27T10:00:00Z',
  startLat: 60.0,
  startLng: 25.0,
  destLat: 60.1,
  destLng: 25.1,
  distance: 5,
};

export async function insertTestVisit(username: string, id = 'test-visit-1'): Promise<void> {
  await db.insert(schema.visits).values({
    id,
    username,
    date: VISIT_BODY.date,
    startLat: VISIT_BODY.startLat,
    startLng: VISIT_BODY.startLng,
    destLat: VISIT_BODY.destLat,
    destLng: VISIT_BODY.destLng,
    distance: VISIT_BODY.distance,
  });
}

export async function insertTestFavorite(username: string, id = 'test-fav-1'): Promise<void> {
  await db.insert(schema.favorites).values({
    id,
    username,
    payload: { name: 'Test Place', lat: 60.0, lng: 25.0 },
  });
}
