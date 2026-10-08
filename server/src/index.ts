// Hono app entry — serves on the systemd proxy socket, or loopback PORT.
import 'dotenv/config';
import { createApp } from './app.js';
import { createDb } from './db.js';
import { inheritedSocketFd, startLoopbackListener, startProxyListener } from './lib/listen.js';
import { startBucketSweeper } from './middleware/rate-limit.js';

const port = parseInt(process.env.PORT || '3700', 10);
const db = createDb(process.env.DATABASE_URL!);
const app = createApp(db);

startBucketSweeper();

const fd = inheritedSocketFd(process.env, process.pid);
if (fd !== undefined) {
  startProxyListener((req, env) => app.fetch(req, env), { fd }, {
    onRefuse: () => {
      console.error('Refusing to start: inherited fd is not a unix socket — check wander-api.socket ListenStream=');
      process.exit(1);
    },
    onReady: () => {
      console.log(`Wander API listening on inherited unix socket (fd ${fd})`);
    },
  });
} else {
  startLoopbackListener((req, env) => app.fetch(req, env), port, () => {
    console.log(`Wander API listening on 127.0.0.1:${port}`);
  });
}
