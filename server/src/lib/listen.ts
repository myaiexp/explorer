// Listener choice — systemd's inherited proxy socket, or loopback TCP.
//
// Production: wander-api.socket owns /run/wander-api.sock (0660 root:www-data)
// and passes it down as fd 3, so the uid boundary is the socket file's mode,
// not a TCP port every local uid can reach (finding #10094). Dev and tests
// bind 127.0.0.1:PORT and never trust forwarding headers there.
import type { Server } from 'node:http';
import { createAdaptorServer, serve } from '@hono/node-server';
import { PROXY_SOCKET_FLAG } from './client-ip.js';

// sd_listen_fds(3): the first passed fd is always 3.
const SD_LISTEN_FDS_START = 3;

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The inherited socket fd, or undefined when systemd passed none. LISTEN_PID
 * must name this process — an env var inherited by some unrelated child is
 * not a socket handed to us.
 */
export function inheritedSocketFd(env: Env, pid: number): number | undefined {
  if (!env.LISTEN_FDS) return undefined;
  if (env.LISTEN_PID !== String(pid)) return undefined;
  const count = Number(env.LISTEN_FDS);
  if (count !== 1) {
    throw new Error(`expected exactly one socket from systemd, got LISTEN_FDS=${env.LISTEN_FDS}`);
  }
  return SD_LISTEN_FDS_START;
}

/**
 * Whether a listening server is bound to a unix socket. Node reports a TCP
 * listener as an address object and an inherited unix fd as null (a string
 * when it bound the path itself). Checked after listen() so a socket unit
 * edited to ListenStream=<port> fails the start instead of silently trusting
 * forwarding headers from every local uid.
 */
export function isUnixListener(address: unknown): boolean {
  return address === null || typeof address === 'string';
}

type Fetch = (req: Request, env?: Record<string, unknown>) => Response | Promise<Response>;
type ProxyListen = { fd: number } | { path: string } | { port: number; host: string };

// Requests are flagged only after listen() reports a unix socket. A TCP fd
// calls onRefuse and leaves the flag off, so a socket unit edited to
// ListenStream=<port> cannot trust forwarding headers. Tests drive this
// without process.exit.
export function startProxyListener(
  fetch: Fetch,
  listen: ProxyListen,
  hooks: { onRefuse: () => void; onReady?: () => void },
): Server {
  let verified = false;
  const server = createAdaptorServer({
    fetch: (req, env) => fetch(req, verified ? { ...env, [PROXY_SOCKET_FLAG]: true } : env),
  }) as Server;
  server.listen(listen, () => {
    if (!isUnixListener(server.address())) {
      hooks.onRefuse();
      return;
    }
    verified = true;
    hooks.onReady?.();
  });
  return server;
}

// Loopback dev/test listener. Never sets PROXY_SOCKET_FLAG — a TCP peer is
// not nginx, whatever headers it sends.
export function startLoopbackListener(fetch: Fetch, port: number, onReady?: () => void): Server {
  return serve(
    {
      fetch: (req, env) => fetch(req, env),
      port,
      hostname: '127.0.0.1',
    },
    onReady,
  ) as Server;
}
