// GET /:username/archive/:section — cursor-paged full-geometry archive dump
import { Hono } from 'hono';
import type { Db } from '../db.js';
import { accountAuth } from '../middleware/auth.js';
import { readRateLimit } from '../middleware/rate-limit.js';
import { ARCHIVE_PAGE_DEFAULT_ROWS, ARCHIVE_PAGE_MAX_ROWS } from '../lib/validate-fields.js';
import { decodeCursor, isArchiveSection, selectArchivePage } from '../lib/archive-page.js';

// Strict integer parse — Number('1.5') and Number(' 2 ') both coerce, and a
// fractional LIMIT would raise 42804 out of Postgres.
function parseLimit(raw: string | undefined): number | null {
  if (raw === undefined) return ARCHIVE_PAGE_DEFAULT_ROWS;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (n < 1 || n > ARCHIVE_PAGE_MAX_ROWS) return null;
  return n;
}

export function accountArchiveRoutes(db: Db): Hono {
  const app = new Hono();

  // The escape hatch for an archive that GET /:username?geometry=full 413s on
  // (idea #3715): one section at a time, newest-first, keyset-paged on
  // (sort column, id), with stored geometry intact. The 413 stays where it is —
  // it is the backstop for the unbounded dump, and this is the bounded walk.
  //
  // Archive recovery only; the frontend never calls it. Same IP read limit and
  // per-account token as every other read.
  app.get('/:username/archive/:section', readRateLimit(), accountAuth(db), async (c) => {
    const username = c.req.param('username')!;
    const section = c.req.param('section')!;

    if (!isArchiveSection(section)) {
      return c.json({ error: `Unknown section '${section}'` }, 400);
    }

    const limit = parseLimit(c.req.query('limit'));
    if (limit === null) {
      return c.json({ error: `limit must be an integer 1–${ARCHIVE_PAGE_MAX_ROWS}` }, 400);
    }

    const rawCursor = c.req.query('cursor');
    const cursor = rawCursor === undefined ? null : decodeCursor(rawCursor);
    if (rawCursor !== undefined && cursor === null) {
      return c.json({ error: 'Malformed cursor' }, 400);
    }

    const page = await selectArchivePage(db, section, username, limit, cursor);
    return c.json({ section, rows: page.rows, nextCursor: page.nextCursor });
  });

  return app;
}
