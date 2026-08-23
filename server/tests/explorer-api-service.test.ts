// Pins deploy/explorer-api.service isolation (finding #7560)
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const unit = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../deploy/explorer-api.service'),
  'utf8',
);

describe('deploy/explorer-api.service sandbox (finding #7560)', () => {
  test('runs as the explorer system user, not the interactive account', () => {
    expect(unit).toMatch(/^User=explorer$/m);
    expect(unit).toMatch(/^Group=explorer$/m);
    expect(unit).not.toMatch(/^User=mase$/m);
  });

  test('hides /home except the server tree and enables the hardening block', () => {
    expect(unit).toMatch(/^ProtectSystem=strict$/m);
    expect(unit).toMatch(/^ProtectHome=tmpfs$/m);
    expect(unit).toMatch(/^PrivateTmp=yes$/m);
    expect(unit).toMatch(/^NoNewPrivileges=yes$/m);
    expect(unit).toMatch(/BindReadOnlyPaths=\/home\/mase\/Projects\/explorer\/server/);
  });

  test('caps process memory so a fat GET cannot OOM the host (finding #7558)', () => {
    expect(unit).toMatch(/^MemoryMax=512M$/m);
  });
});
