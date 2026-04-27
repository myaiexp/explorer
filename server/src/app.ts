// Hono app factory — assembles middleware + route modules.
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Db } from './db.js';
import { accountsRoutes } from './routes/accounts.js';
import { fetchRoutes } from './routes/fetch.js';
import { importRoutes } from './routes/import.js';
import { sectionsRoutes } from './routes/sections.js';

export function createApp(db: Db): Hono {
  const app = new Hono();

  app.use(
    '*',
    cors({
      origin: ['https://mase.fi', 'http://localhost:8080', 'http://localhost:9755'],
    })
  );

  app.get('/api/health', (c) => c.json({ status: 'ok' }));

  app.route('/api', accountsRoutes(db));
  app.route('/api', sectionsRoutes(db));
  app.route('/api', importRoutes(db));
  app.route('/api', fetchRoutes(db));

  return app;
}
