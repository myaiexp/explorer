// Hono app entry — starts HTTP server on PORT, mounts routes.
import 'dotenv/config';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { createDb } from './db.js';
import { startBucketSweeper } from './middleware/rate-limit.js';

const port = parseInt(process.env.PORT || '3700', 10);
const db = createDb(process.env.DATABASE_URL!);
const app = createApp(db);

startBucketSweeper();

serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
  console.log(`Explorer API listening on 127.0.0.1:${port}`);
});
