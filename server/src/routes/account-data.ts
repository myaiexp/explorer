// GET /:username — four-section account snapshot (cloud-backup read)
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { Db } from '../db.js';
import { schema } from '../db.js';
import { accountAuth } from '../middleware/auth.js';
import { readRateLimit } from '../middleware/rate-limit.js';
import { GET_SNAPSHOT_MAX_BYTES } from '../lib/validate-fields.js';
import { selectFavoriteSection } from '../lib/favorite-snapshot.js';
import { estimateStoredSnapshotBytes } from '../lib/snapshot-size.js';
import { selectTripSection } from '../lib/trip-snapshot.js';

export function accountDataRoutes(db: Db): Hono {
  const app = new Hono();

  // GET /:username — return all four sections. IP rate limit runs first
  // (throttles probing), then per-account token auth. Visit/history polylines
  // and favorite payloads older than GET_GEOMETRY_KEEP are stripped so the
  // init-path merge (sync.js Case 2) stays bounded. `?geometry=full` returns
  // the archive only when stored jsonb is under GET_SNAPSHOT_MAX_BYTES;
  // otherwise 413 so Node never JSON-encodes a multi-GB fill (finding #7558).
  app.get('/:username', readRateLimit(), accountAuth(db), async (c) => {
    const username = c.req.param('username')!;
    const fullGeometry = c.req.query('geometry') === 'full';

    if (fullGeometry) {
      const bytes = await estimateStoredSnapshotBytes(db, username);
      if (bytes > GET_SNAPSHOT_MAX_BYTES) {
        return c.json(
          { error: `Snapshot exceeds maximum size of ${GET_SNAPSHOT_MAX_BYTES} bytes` },
          413,
        );
      }
    }

    const [visits, favorites, savedLocations, history] = await Promise.all([
      selectTripSection(db, schema.visits, username, fullGeometry),
      selectFavoriteSection(db, username, fullGeometry),
      db.select().from(schema.savedLocations).where(eq(schema.savedLocations.username, username)),
      selectTripSection(db, schema.history, username, fullGeometry),
    ]);

    return c.json({ visits, favorites, savedLocations, history });
  });

  return app;
}
