// Hono app entry — serves on the systemd proxy socket, or loopback PORT.
import 'dotenv/config';
import { createAdaptorServer, serve } from '@hono/node-server';
import { createApp } from './app.js';
import { createDb } from './db.js';
import { PROXY_SOCKET_FLAG } from './lib/client-ip.js';
import { inheritedSocketFd, isUnixListener } from './lib/listen.js';
import { startBucketSweeper } from './middleware/rate-limit.js';

const port = parseInt(process.env.PORT || '3700', 10);
const db = createDb(process.env.DATABASE_URL!);
const app = createApp(db);

startBucketSweeper();

const fd = inheritedSocketFd(process.env, process.pid);
if (fd !== undefined) {
  // Requests are only flagged once the listener is confirmed to be a unix
  // socket; anything accepted before that check runs is keyed as untrusted.
  let verified = false;
  const server = createAdaptorServer({
    fetch: (req, env) => app.fetch(req, verified ? { ...env, [PROXY_SOCKET_FLAG]: true } : env),
  });
  server.listen({ fd }, () => {
    if (!isUnixListener(server.address())) {
      console.error('Refusing to start: inherited fd is not a unix socket — check wander-api.socket ListenStream=');
      process.exit(1);
    }
    verified = true;
    console.log(`Wander API listening on inherited unix socket (fd ${fd})`);
  });
} else {
  serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
    console.log(`Wander API listening on 127.0.0.1:${port}`);
  });
}
