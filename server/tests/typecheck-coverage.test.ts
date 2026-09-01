// What `tsc --noEmit` covers — the gap idea #4045 closed, pinned.
//
// The base tsconfig used to include src/**/* alone, so the command a session types
// before committing checked neither this directory nor scripts/. It reported clean
// while two real TS2322s sat in tests/, and nothing anywhere said so: vitest runs
// these files through esbuild, which strips types without checking them.
//
// The fix is the DEFAULT being wide and the build being the narrow special case, so
// there is no second command to remember. These assertions are what stops that
// getting quietly reversed by a later edit — a re-narrowed include fails here rather
// than silently un-checking 25 files again.
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SERVER_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// tsconfig files carry comments, so JSON.parse is not enough.
function readJsonc<T>(name: string): T {
  const raw = readFileSync(join(SERVER_ROOT, name), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  return JSON.parse(raw) as T;
}

interface TsConfig {
  extends?: string;
  compilerOptions?: Record<string, unknown>;
  include?: string[];
}

describe('tsconfig.json — the default type-check', () => {
  const base = readJsonc<TsConfig>('tsconfig.json');

  test('covers src, tests and scripts', () => {
    expect(base.include).toEqual(expect.arrayContaining(['src/**/*', 'tests/**/*', 'scripts/**/*']));
  });

  test('emits nothing, so a bare `tsc` cannot scatter .js beside the sources', () => {
    expect(base.compilerOptions?.noEmit).toBe(true);
  });

  test('stays strict', () => {
    expect(base.compilerOptions?.strict).toBe(true);
  });
});

describe('tsconfig.build.json — what deploy compiles', () => {
  const build = readJsonc<TsConfig>('tsconfig.build.json');

  test('extends the base rather than restating the compiler options', () => {
    expect(build.extends).toBe('./tsconfig.json');
  });

  // rootDir: 'src' with include: ['src/**/*'] is what puts the entry point at
  // dist/index.js — the path deploy/explorer-api.service's ExecStart names.
  test('emits only src, rooted so the entry lands at dist/index.js', () => {
    expect(build.include).toEqual(['src/**/*']);
    expect(build.compilerOptions?.rootDir).toBe('src');
    expect(build.compilerOptions?.outDir).toBe('dist');
    expect(build.compilerOptions?.noEmit).toBe(false);
  });

  test('is the config `pnpm build` actually runs', () => {
    const pkg = readJsonc<{ scripts: Record<string, string> }>('package.json');
    expect(pkg.scripts.build).toContain('tsconfig.build.json');
  });
});
