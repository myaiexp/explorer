// Resolve + hard-guard the test database URL — tests must NEVER touch prod.
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Load server/.env into process.env so the app under test sees the real config —
// notably NODE_ENV=production, which gates the CORS allowlist (see app.ts). override
// makes this deterministic regardless of the ambient session env (a Helm-spawned
// session exports its own unrelated DATABASE_URL/NODE_ENV). The prod DATABASE_URL
// this puts in process.env is inert: helpers.ts connects only to the guarded *_test
// URL derived below, and nothing else in the test suite reads DATABASE_URL.
const envFile = config({ path: resolve(__dirname, '../.env'), override: true }).parsed ?? {};

// Database name of a postgres URL: strip scheme://authority and any ?query/#frag,
// leaving the last path segment. String-based so it can't throw on socket-style
// URLs (e.g. postgresql://user@/db?host=/var/run/postgresql) the way `new URL` does.
export function dbNameOf(url: string): string {
  const path = url
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '') // drop scheme://authority
    .replace(/[?#].*$/, ''); // drop query/fragment
  return path.replace(/^\/+/, '');
}

// Swap a postgres URL's database name to `<name>_test` (idempotent).
export function toTestUrl(url: string): string {
  const name = dbNameOf(url);
  if (!name || name.endsWith('_test')) return url;
  const cut = url.search(/[?#]/); // preserve any ?query when re-appending
  const path = cut === -1 ? url : url.slice(0, cut);
  const query = cut === -1 ? '' : url.slice(cut);
  return `${path}_test${query}`;
}

// Core of resolveTestDatabaseUrl, parameterized so tests don't mutate process.env.
export function guardedTestUrl(
  explicit: string | undefined,
  fallback: string | undefined,
): string {
  const base = explicit ?? fallback;
  if (!base) throw new Error('Neither TEST_DATABASE_URL nor .env DATABASE_URL is set');
  const url = explicit ?? toTestUrl(base);
  const dbName = dbNameOf(url);
  if (!dbName.endsWith('_test')) {
    throw new Error(
      `Refusing to run tests against non-test database "${dbName}". ` +
        `The test database name must end in "_test" — set TEST_DATABASE_URL to a *_test DB, ` +
        `or use a .env DATABASE_URL whose db name can be suffixed with _test.`,
    );
  }
  return url;
}

// The URL the test suite connects to. An explicit TEST_DATABASE_URL (e.g. CI) is
// used verbatim; otherwise the wander db name from .env is suffixed with _test.
// Either way a hard `_test`-suffix guard makes it impossible to run the destructive
// suite (truncateAll) against a production db, even with a misconfigured / copied .env.
export function resolveTestDatabaseUrl(): string {
  return guardedTestUrl(process.env.TEST_DATABASE_URL, envFile.DATABASE_URL);
}
