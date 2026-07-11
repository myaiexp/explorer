// Hono app factory — assembles middleware + route modules.
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import type { Db } from './db.js';
import { accountsRoutes } from './routes/accounts.js';
import { accountDataRoutes } from './routes/account-data.js';
import { importRoutes } from './routes/import.js';
import { sectionsRoutes } from './routes/sections.js';

export function createApp(db: Db): Hono {
  const app = new Hono();

  // Defense-in-depth security headers. Responses are JSON-only, so a
  // locked-down CSP (default-src 'none') and DENY framing are appropriate —
  // there is nothing legitimate to render, embed, or frame from this origin.
  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      xFrameOptions: 'DENY',
      referrerPolicy: 'no-referrer',
      // xContentTypeOptions defaults to 'nosniff'
    })
  );

  // Production allows only the deployed frontend origin. Localhost dev origins
  // are added only outside production (gated by NODE_ENV) so a local page can't
  // make credentialed cross-origin requests against the live API.
  const allowedOrigins = ['https://mase.fi'];
  if (process.env.NODE_ENV !== 'production') {
    allowedOrigins.push('http://localhost:8080', 'http://localhost:9755');
  }

  app.use('*', cors({ origin: allowedOrigins }));

  app.get('/api/health', (c) => c.json({ status: 'ok' }));

  app.route('/api', accountsRoutes(db));
  app.route('/api', sectionsRoutes(db));
  app.route('/api', importRoutes(db));
  app.route('/api', accountDataRoutes(db));

  return app;
}
