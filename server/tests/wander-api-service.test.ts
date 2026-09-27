// Pins deploy/wander-api.service isolation (finding #7560)
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const unit = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../deploy/wander-api.service'),
  'utf8',
);

describe('deploy/wander-api.service sandbox (finding #7560)', () => {
  test('runs as the wander system user, not the interactive account', () => {
    expect(unit).toMatch(/^User=wander$/m);
    expect(unit).toMatch(/^Group=wander$/m);
    expect(unit).not.toMatch(/^User=mase$/m);
  });

  test('hides /home except the server tree and enables the hardening block', () => {
    expect(unit).toMatch(/^ProtectSystem=strict$/m);
    expect(unit).toMatch(/^ProtectHome=tmpfs$/m);
    expect(unit).toMatch(/^PrivateTmp=yes$/m);
    expect(unit).toMatch(/^NoNewPrivileges=yes$/m);
    // ProtectHome stays tmpfs, never yes: yes overmounts /home and hides the
    // bind target underneath it, so the service cannot read its own tree.
    expect(unit).toMatch(/BindReadOnlyPaths=\/home\/mase\/Projects\/wander\/server/);
  });

  test('caps process memory so a fat GET cannot OOM the host (finding #7558)', () => {
    expect(unit).toMatch(/^MemoryMax=512M$/m);
  });
});

// Finding #10094: loopback TCP was reachable by every local uid, and wander-api
// trusted X-Real-IP from any loopback peer. The socket's mode is the boundary.
describe('deploy/wander-api.socket — nginx is the only client (finding #10094)', () => {
  const deployDir = join(dirname(fileURLToPath(import.meta.url)), '../../deploy');
  const socket = readFileSync(join(deployDir, 'wander-api.socket'), 'utf8');
  const nginx = readFileSync(join(deployDir, 'nginx-wander.conf'), 'utf8');

  test('is a 0660 root:www-data unix socket, not a TCP port', () => {
    expect(socket).toMatch(/^ListenStream=\/run\/wander-api\.sock$/m);
    expect(socket).toMatch(/^SocketMode=0660$/m);
    expect(socket).toMatch(/^SocketUser=root$/m);
    expect(socket).toMatch(/^SocketGroup=www-data$/m);
  });

  test('the service requires it, and nginx proxies to the same path', () => {
    expect(unit).toMatch(/^Requires=wander-api\.socket$/m);
    expect(unit).toMatch(/^After=.*\bwander-api\.socket\b/m);
    expect(nginx).toMatch(/proxy_pass http:\/\/unix:\/run\/wander-api\.sock:/);
  });

  test('the sandbox still permits AF_UNIX', () => {
    expect(unit).toMatch(/^RestrictAddressFamilies=.*\bAF_UNIX\b/m);
  });
});
