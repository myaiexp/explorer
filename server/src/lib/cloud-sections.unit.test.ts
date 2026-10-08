// Client/server cloud-backup section names stay one set (DATA_SECTIONS ↔ ARCHIVE_SECTIONS).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ARCHIVE_SECTIONS } from './archive-page.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

function quotedList(src: string, decl: string): string[] {
  const m = src.match(new RegExp(`${decl} = \\[([^\\]]+)\\]`));
  if (!m) throw new Error(`${decl} not found`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((hit) => hit[1]);
}

describe('cloud-backup section names', () => {
  it('client DATA_SECTIONS is the same set as ARCHIVE_SECTIONS', () => {
    const src = readFileSync(join(ROOT, 'sync-sections.js'), 'utf8');
    const client = quotedList(src, 'var DATA_SECTIONS');
    expect(client).toHaveLength(ARCHIVE_SECTIONS.length);
    expect(new Set(client)).toEqual(new Set(ARCHIVE_SECTIONS));
    for (const name of ARCHIVE_SECTIONS) {
      expect(src).toContain(`case '${name}'`);
    }
  });

  it('import allows exactly those keys and reads each one off the body', () => {
    const src = readFileSync(join(ROOT, 'server/src/routes/import.ts'), 'utf8');
    expect(src).toMatch(/new Set<string>\(ARCHIVE_SECTIONS\)/);
    for (const name of ARCHIVE_SECTIONS) {
      expect(src).toContain(`body.${name}`);
    }
  });

  it('GET /:username returns every section', () => {
    const src = readFileSync(join(ROOT, 'server/src/routes/account-data.ts'), 'utf8');
    const m = src.match(/return c\.json\(\{ ([^}]+) \}\)/);
    expect(m).toBeTruthy();
    const keys = m![1].split(',').map((s) => s.trim()).filter(Boolean);
    expect(new Set(keys)).toEqual(new Set(ARCHIVE_SECTIONS));
  });
});
