// Ported from helm's src/db/destructive-ddl.test.ts (idea #3965), with the
// corpus half re-pointed at wander's own drizzle/ — the scan is only worth
// having if it is right about THIS repo's migrations.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { blankSqlNoise, findDestructiveDdl } from './destructive-ddl.js';

const SERVER_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATIONS = join(SERVER_ROOT, 'drizzle');

const kinds = (sql: string): string[] => findDestructiveDdl(sql).map((f) => f.kind);
const sqlFiles = (): string[] => readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'));

describe('blankSqlNoise', () => {
  it('preserves length and line structure so offsets survive', () => {
    const sql = "-- drop everything\nSELECT 'x';\n/* gone */\n";
    const blanked = blankSqlNoise(sql);
    expect(blanked).toHaveLength(sql.length);
    expect(blanked.split('\n')).toHaveLength(sql.split('\n').length);
  });

  it('blanks line comments, block comments, and string literals', () => {
    const blanked = blankSqlNoise("-- DROP TABLE a\n/* DROP TABLE b */ SELECT 'DROP TABLE c';");
    expect(blanked).not.toMatch(/DROP/);
    expect(blanked).toMatch(/SELECT/);
  });

  it('handles nested block comments (Postgres nests them)', () => {
    const blanked = blankSqlNoise('/* outer /* inner */ still comment */ DROP TABLE t;');
    expect(blanked).toMatch(/DROP TABLE t/);
    expect(blanked).not.toMatch(/inner/);
  });

  it('handles doubled-quote escapes without swallowing the rest of the file', () => {
    const blanked = blankSqlNoise("SELECT 'it''s fine'; DROP TABLE t;");
    expect(blanked).toMatch(/DROP TABLE t/);
    expect(blanked).not.toMatch(/fine/);
  });

  it('handles dollar-quoted bodies', () => {
    const blanked = blankSqlNoise(
      'CREATE FUNCTION f() RETURNS void AS $body$ DROP TABLE inner_t; $body$ LANGUAGE sql;',
    );
    expect(blanked).not.toMatch(/inner_t/);
  });

  it('leaves a bare $1 placeholder alone', () => {
    expect(blankSqlNoise('UPDATE t SET a = $1 WHERE b = $2;')).toContain('$1');
  });
});

describe('findDestructiveDdl — destructive statements', () => {
  it.each([
    ['ALTER TABLE t DROP COLUMN IF EXISTS c;', 'DROP COLUMN'],
    ['ALTER TABLE t DROP c;', 'DROP COLUMN'], // the COLUMN keyword is optional in Postgres
    ['DROP TABLE IF EXISTS t;', 'DROP TABLE'],
    ['DROP MATERIALIZED VIEW v;', 'DROP VIEW'],
    ['DROP INDEX idx;', 'DROP INDEX'],
    ['DROP TYPE mood;', 'DROP TYPE'],
    ['ALTER TABLE t DROP CONSTRAINT t_pkey;', 'DROP CONSTRAINT'],
    ['ALTER TABLE t ALTER COLUMN c DROP DEFAULT;', 'DROP DEFAULT'],
    ['ALTER TABLE t RENAME COLUMN a TO b;', 'RENAME'],
    ['ALTER TABLE t ALTER COLUMN c SET NOT NULL;', 'SET NOT NULL'],
    ['ALTER TABLE t ALTER COLUMN c TYPE integer;', 'ALTER COLUMN TYPE'],
    ['ALTER TABLE t ALTER COLUMN c SET DATA TYPE integer;', 'ALTER COLUMN TYPE'],
    ['TRUNCATE visits;', 'TRUNCATE'],
    ['DELETE FROM visits;', 'DELETE'],
  ])('flags %s as %s', (sql, kind) => {
    expect(kinds(sql)).toContain(kind);
  });
});

describe('findDestructiveDdl — statements that must NOT be flagged', () => {
  it.each([
    'ALTER TABLE t ADD COLUMN IF NOT EXISTS c text;',
    'CREATE TABLE IF NOT EXISTS t (id serial primary key, c text NOT NULL);',
    'CREATE INDEX IF NOT EXISTS idx ON t (c);',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx ON t (c);',
    'ALTER TABLE t ALTER COLUMN c DROP NOT NULL;', // relaxing — never breaks older code
    "ALTER TYPE mood ADD VALUE IF NOT EXISTS 'ok';", // additive enum value
    "UPDATE t SET c = 'x' WHERE c IS NULL;",
    'ALTER TABLE t ADD CONSTRAINT t_chk CHECK (c > 0);',
    // `ON DELETE`/`SET NULL` inside a foreign key is referential action, not a DELETE.
    // Every table in 0000 carries one, so this is the file's dominant shape.
    'ALTER TABLE t ADD CONSTRAINT fk FOREIGN KEY (a) REFERENCES u(id) ON DELETE cascade ON UPDATE no action;',
    'CREATE TABLE t (a integer REFERENCES u(id) ON DELETE SET NULL);',
  ])('leaves %s alone', (sql) => {
    expect(findDestructiveDdl(sql)).toEqual([]);
  });

  it('does not flag prose that merely describes a drop', () => {
    const sql = [
      '-- 0999_notes',
      '-- We will DROP COLUMN route_coords in a later migration; TRUNCATE is never used.',
      '/* DROP TABLE visits would be wrong here. */',
      'ALTER TABLE visits ADD COLUMN IF NOT EXISTS trip_mode text;',
    ].join('\n');
    expect(findDestructiveDdl(sql)).toEqual([]);
  });
});

describe('findDestructiveDdl — reporting', () => {
  it('reports the line of the keyword, not of the leading comment block', () => {
    const sql = ['-- a comment', '-- another comment', '', 'ALTER TABLE t DROP COLUMN c;'].join('\n');
    expect(findDestructiveDdl(sql)).toEqual([
      { line: 4, kind: 'DROP COLUMN', statement: 'ALTER TABLE t DROP COLUMN c' },
    ]);
  });

  it('excerpts the statement without its preceding comments', () => {
    const sql = '-- explanation of why\nDROP TABLE t;';
    expect(findDestructiveDdl(sql)[0].statement).toBe('DROP TABLE t');
  });

  it('keeps quoted identifiers in the excerpt', () => {
    // Identifiers are blanked for SCANNING only. Excerpting off the blanked copy
    // trims a trailing `"column"` and prints a statement that looks truncated.
    expect(findDestructiveDdl('ALTER TABLE "visits" DROP COLUMN IF EXISTS "route_coords";')[0].statement).toBe(
      'ALTER TABLE "visits" DROP COLUMN IF EXISTS "route_coords"',
    );
  });

  it('still refuses to scan inside a quoted identifier', () => {
    // A column named "drop" is not a DROP — that is why identifiers are blanked.
    expect(findDestructiveDdl('ALTER TABLE t ADD COLUMN IF NOT EXISTS "drop" text;')).toEqual([]);
  });

  it('reports one finding per kind, in file order', () => {
    const sql = ['ALTER TABLE t DROP COLUMN a;', 'ALTER TABLE t DROP COLUMN b;', 'DROP TABLE u;'].join('\n');
    expect(findDestructiveDdl(sql).map((f) => [f.line, f.kind])).toEqual([
      [1, 'DROP COLUMN'],
      [2, 'DROP COLUMN'],
      [3, 'DROP TABLE'],
    ]);
  });

  it('tolerates a final statement with no trailing semicolon', () => {
    expect(kinds('DROP TABLE t')).toEqual(['DROP TABLE']);
  });

  it('ignores drizzle statement-breakpoint markers', () => {
    const sql = 'ALTER TABLE t ADD COLUMN c text;\n--> statement-breakpoint\nCREATE INDEX idx ON t (c);';
    expect(findDestructiveDdl(sql)).toEqual([]);
  });
});

describe('findDestructiveDdl — against wander\'s own migrations', () => {
  // The false-NEGATIVE half. 0002 is the destructive one in this repo: it swaps the
  // per-table username indexes and primary keys, so a classifier that stopped
  // recognising DROP INDEX / DROP CONSTRAINT goes red here rather than quietly
  // waving a schema contraction through from a worktree.
  it('flags the index and constraint drops in 0002', () => {
    const found = findDestructiveDdl(readFileSync(join(MIGRATIONS, '0002_cool_union_jack.sql'), 'utf8'));
    expect(found.map((f) => f.kind)).toContain('DROP INDEX');
    expect(found.map((f) => f.kind)).toContain('DROP CONSTRAINT');
  });

  it('flags the SET NOT NULL in 0001 — an insert omitting the column starts failing', () => {
    expect(kinds(readFileSync(join(MIGRATIONS, '0001_silly_fixer.sql'), 'utf8'))).toContain('SET NOT NULL');
  });

  // The false-POSITIVE half, and the one shape most likely to break it: every table
  // in 0000 gets a foreign key with `ON DELETE cascade`. Reading that as a DELETE
  // would make the guard refuse the initial schema — the most additive file there is.
  it('leaves the initial CREATE TABLE migration alone despite its ON DELETE cascade', () => {
    const sql = readFileSync(join(MIGRATIONS, '0000_quick_vin_gonzales.sql'), 'utf8');
    expect(sql).toContain('ON DELETE cascade');
    expect(findDestructiveDdl(sql)).toEqual([]);
  });

  it('leaves the majority of the corpus alone', () => {
    const flagged = sqlFiles().filter(
      (f) => findDestructiveDdl(readFileSync(join(MIGRATIONS, f), 'utf8')).length > 0,
    );
    expect(flagged.length / sqlFiles().length).toBeLessThan(0.75);
  });
});
