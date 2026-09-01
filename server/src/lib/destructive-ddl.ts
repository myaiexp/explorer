// Which migration DDL breaks the code that predates it — pure, no I/O.
//
// server/.env aims DATABASE_URL at the production `wander` database and Helm copies
// that file into every worktree, so `pnpm db:migrate` from a worktree writes PROD's
// schema while prod still runs master. Additive DDL is safe by construction (the running
// code ignores a column it doesn't know about); the statements below are not — they
// remove or narrow a surface the deployed code may still be using, so they must land
// WITH the code that stopped using it. `src/lib/migrate-guard.ts` turns these findings
// into a verdict.
//
// The scan is deliberately conservative in ONE direction only: a false positive costs a
// migration nothing but a slightly later application (forgejo-deploy runs drizzle-kit
// migrate in ~/Projects/wander/server the moment the push lands), while a false
// negative is helm's 2026-08-22 incident — four columns dropped from a worktree, 25
// minutes of HTTP 500 — reproduced here.
//
// Ported from helm's src/db/destructive-ddl.ts (idea #3965). Kept a copy rather than a
// shared package because the two repos share no build; the unit tests are the parity.

/** One destructive statement found in a migration file. */
export interface DestructiveStatement {
  /** 1-based line of the offending keyword in the original .sql. */
  line: number;
  /** What makes it destructive, e.g. 'DROP COLUMN'. */
  kind: string;
  /** The statement itself, whitespace-collapsed and truncated for a terminal. */
  statement: string;
}

/** Longest excerpt of a statement we print in a refusal. */
const EXCERPT_CHARS = 110;

/**
 * Blank out everything a keyword scan must not see — comments and literals — replacing
 * each byte with a space so offsets and line numbers survive intact.
 *
 * This is what stops a migration's own prose from tripping the scan: 0002's comment
 * says "per-table username indexes are dropped as redundant" two lines above the DROP
 * INDEX statements, and a naive `rg DROP` over the file cannot tell one from the other.
 *
 * Postgres specifics that matter: block comments NEST, dollar-quoting (`$$…$$`,
 * `$tag$…$tag$`) is the usual way a migration carries a function body, and under
 * standard_conforming_strings (on since 9.1) a backslash inside `'…'` is an ordinary
 * character — only a doubled quote escapes.
 */
export function blankSqlNoise(sql: string): string {
  const out = sql.split('');
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to && i < out.length; i++) {
      if (out[i] !== '\n') out[i] = ' ';
    }
  };

  let i = 0;
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);

    if (two === '--') {
      const end = sql.indexOf('\n', i);
      blank(i, end === -1 ? sql.length : end);
      i = end === -1 ? sql.length : end;
      continue;
    }

    if (two === '/*') {
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql.slice(j, j + 2) === '/*') {
          depth++;
          j += 2;
        } else if (sql.slice(j, j + 2) === '*/') {
          depth--;
          j += 2;
        } else {
          j++;
        }
      }
      blank(i, j);
      i = j;
      continue;
    }

    if (sql[i] === "'" || sql[i] === '"') {
      const quote = sql[i];
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === quote) {
          if (sql[j + 1] === quote) {
            j += 2; // doubled quote — an escaped quote, string continues
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      blank(i, j);
      i = j;
      continue;
    }

    // Dollar quoting: $tag$ … $tag$ (tag may be empty). Only a valid tag opens one, so
    // an ordinary `$1` placeholder falls through untouched.
    const dollar = /^\$([A-Za-z_][A-Za-z_0-9]*)?\$/.exec(sql.slice(i));
    if (dollar) {
      const close = sql.indexOf(dollar[0], i + dollar[0].length);
      const end = close === -1 ? sql.length : close + dollar[0].length;
      blank(i, end);
      i = end;
      continue;
    }

    i++;
  }

  return out.join('');
}

/** 1-based line number of `index` within `text`. */
function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

/** The object kinds a `DROP <kind>` can name, all of which remove a live surface. */
const DROPPABLE = new Set([
  'TABLE',
  'VIEW',
  'INDEX',
  'TYPE',
  'SCHEMA',
  'SEQUENCE',
  'FUNCTION',
  'PROCEDURE',
  'TRIGGER',
  'RULE',
  'DOMAIN',
  'POLICY',
  'EXTENSION',
  'CONSTRAINT',
  'DEFAULT',
  'IDENTITY',
  'EXPRESSION',
]);

/**
 * Classify the word at `pos` in an uppercased word list, or null if it is harmless.
 *
 * `DROP NOT NULL` is deliberately harmless: relaxing a constraint can never break code
 * that predates it. `SET NOT NULL` is its destructive twin — an INSERT that omits the
 * column starts failing the moment it lands.
 */
function classifyAt(words: string[], pos: number): string | null {
  const w = words[pos];
  const next = words[pos + 1];
  const after = words[pos + 2];

  if (w === 'DROP') {
    if (next === 'NOT' && after === 'NULL') return null; // relaxing — safe
    if (next === 'MATERIALIZED' && after === 'VIEW') return 'DROP VIEW';
    if (next === 'COLUMN') return 'DROP COLUMN';
    if (next && DROPPABLE.has(next)) return `DROP ${next}`;
    // `ALTER TABLE t DROP c` and `… DROP IF EXISTS c` — the COLUMN keyword is optional.
    return next ? 'DROP COLUMN' : null;
  }

  if (w === 'RENAME') return 'RENAME';
  if (w === 'SET' && next === 'NOT' && after === 'NULL') return 'SET NOT NULL';
  if (w === 'TRUNCATE') return 'TRUNCATE';
  if (w === 'DELETE' && next === 'FROM') return 'DELETE';

  // `ALTER … ALTER COLUMN c TYPE …` / `… SET DATA TYPE …` rewrites a column's type.
  // Excluded: `ALTER TYPE t ADD VALUE` (pos 1 — additive) and `DROP TYPE` (handled above).
  if (w === 'TYPE' && words[0] === 'ALTER' && pos > 1 && words[pos - 1] !== 'DROP' && words[pos - 1] !== 'CREATE') {
    return 'ALTER COLUMN TYPE';
  }

  return null;
}

/**
 * Every destructive statement in one migration file, in file order, one finding per
 * (statement, kind) pair.
 *
 * Statements are split on `;` over the BLANKED text, so a semicolon inside a comment or
 * a string cannot end one, and a statement's leading comment block is not mistaken for
 * its opening keyword.
 */
export function findDestructiveDdl(sql: string): DestructiveStatement[] {
  const blanked = blankSqlNoise(sql);
  const findings: DestructiveStatement[] = [];

  let start = 0;
  for (let i = 0; i <= blanked.length; i++) {
    if (i < blanked.length && blanked[i] !== ';') continue;

    const segment = blanked.slice(start, i);
    // Leading blanks here are the statement's comment block, already blanked out — so
    // trimming them is what makes `base` the first real character of the DDL itself.
    const lead = segment.length - segment.trimStart().length;
    const base = start + lead;
    const end = i;
    start = i + 1;

    const body = blanked.slice(base, end);
    if (!body.trim()) continue;

    const words: string[] = [];
    const offsets: number[] = [];
    for (const m of body.matchAll(/[A-Za-z_][A-Za-z_0-9]*/g)) {
      words.push(m[0].toUpperCase());
      offsets.push(m.index);
    }

    // The excerpt comes from the ORIGINAL text over the same span: identifiers and
    // literals are blanked for scanning only, and an excerpt trimmed on the blanked
    // copy loses a trailing `"column_name"` — printing a statement that looks truncated.
    const excerpt = sql
      .slice(base, end)
      .replace(/\s+/g, ' ')
      .trim();
    const statement = excerpt.length > EXCERPT_CHARS ? `${excerpt.slice(0, EXCERPT_CHARS - 1)}…` : excerpt;

    const seen = new Set<string>();
    for (let p = 0; p < words.length; p++) {
      const kind = classifyAt(words, p);
      if (!kind || seen.has(kind)) continue;
      seen.add(kind);
      findings.push({ line: lineOf(sql, base + offsets[p]), kind, statement });
    }
  }

  return findings.sort((a, b) => a.line - b.line);
}
