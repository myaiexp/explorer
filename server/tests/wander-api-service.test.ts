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
