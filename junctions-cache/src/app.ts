// Hono app factory — composition root. Every route lives in ./routes/*.

import { Hono } from 'hono';
import { registerMetaRoutes } from './routes/meta.js';
import { registerJunctionsRoutes } from './routes/junctions.js';
import { registerPoolRoutes } from './routes/pools.js';

export function createApp(): Hono {
    const app = new Hono();

    // Each register* call mints its own per-IP rate limiters, so a fresh
    // createApp() gets fresh buckets (tests) rather than process singletons.
    registerMetaRoutes(app);
    registerJunctionsRoutes(app);
    registerPoolRoutes(app);

    return app;
}
