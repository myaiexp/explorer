// Unit tests for the systemd socket-activation listener checks (finding #10094).
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { PROXY_SOCKET_FLAG } from './client-ip.js';
import {
  inheritedSocketFd,
  isUnixListener,
  startLoopbackListener,
  startProxyListener,
} from './listen.js';

const open: Server[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

function bodyOf(opts: { socketPath?: string; port?: number; host?: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ ...opts, path: '/' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString()));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('inheritedSocketFd', () => {
  it('returns fd 3 when systemd passed one socket to this pid', () => {
    expect(inheritedSocketFd({ LISTEN_FDS: '1', LISTEN_PID: '4242' }, 4242)).toBe(3);
  });

  it('returns undefined without LISTEN_FDS (dev / tests bind loopback TCP)', () => {
    expect(inheritedSocketFd({}, 4242)).toBeUndefined();
  });

  it('ignores LISTEN_FDS meant for another process', () => {
    expect(inheritedSocketFd({ LISTEN_FDS: '1', LISTEN_PID: '1' }, 4242)).toBeUndefined();
    expect(inheritedSocketFd({ LISTEN_FDS: '1' }, 4242)).toBeUndefined();
  });

  it('refuses a socket count other than one', () => {
    expect(() => inheritedSocketFd({ LISTEN_FDS: '2', LISTEN_PID: '4242' }, 4242)).toThrow(/LISTEN_FDS=2/);
  });
});

describe('isUnixListener', () => {
  // Shapes observed from node:http under systemd-socket-activate.
  it('accepts an inherited unix fd (null) or a bound path (string)', () => {
    expect(isUnixListener(null)).toBe(true);
    expect(isUnixListener('/run/wander-api.sock')).toBe(true);
  });

  it('rejects a TCP listener', () => {
    expect(isUnixListener({ address: '127.0.0.1', family: 'IPv4', port: 3700 })).toBe(false);
  });
});

describe('startProxyListener', () => {
  it('flags a request accepted on a unix socket', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wander-sock-'));
    const socketPath = join(dir, 'api.sock');
    let seen: Record<string, unknown> | undefined;
    const server = startProxyListener(
      async (_req, env) => {
        seen = env;
        return new Response('ok');
      },
      { path: socketPath },
      { onRefuse: () => { throw new Error('refused a unix socket'); } },
    );
    open.push(server);
    await once(server, 'listening');
    expect(await bodyOf({ socketPath })).toBe('ok');
    expect(seen?.[PROXY_SOCKET_FLAG]).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  it('does not flag a TCP listener and calls onRefuse', async () => {
    let refused = 0;
    let seen: Record<string, unknown> | undefined;
    const server = startProxyListener(
      async (_req, env) => {
        seen = env;
        return new Response('tcp');
      },
      { port: 0, host: '127.0.0.1' },
      { onRefuse: () => { refused += 1; } },
    );
    open.push(server);
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected a TCP address');
    expect(refused).toBe(1);
    expect(await bodyOf({ host: '127.0.0.1', port: address.port })).toBe('tcp');
    expect(seen?.[PROXY_SOCKET_FLAG]).not.toBe(true);
  });
});

describe('startLoopbackListener', () => {
  it('never sets the proxy-socket flag', async () => {
    let seen: Record<string, unknown> | undefined;
    const server = startLoopbackListener(async (_req, env) => {
      seen = env;
      return new Response('loop');
    }, 0);
    open.push(server);
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected a TCP address');
    expect(await bodyOf({ host: '127.0.0.1', port: address.port })).toBe('loop');
    expect(seen?.[PROXY_SOCKET_FLAG]).not.toBe(true);
  });
});
