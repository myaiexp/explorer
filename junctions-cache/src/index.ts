// Process entry — load the cache snapshot, then serve.

import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadCache } from './cache.js';
import { log } from './log.js';

const PORT = parseInt(process.env.PORT ?? '5001', 10);
const HOST = process.env.HOST ?? '127.0.0.1';

const app = createApp();

await loadCache();
serve({ fetch: app.fetch, port: PORT, hostname: HOST });
log('INFO', { event: 'started', host: HOST, port: PORT });
