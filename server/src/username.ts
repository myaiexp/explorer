import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from './db.js';
import { schema } from './db.js';
import adjectives from './wordlists/adjectives.js';
import nouns from './wordlists/nouns.js';

export function generateUsername(): string {
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const n = Math.floor(Math.random() * 100);
  return `${adj}-${noun}-${String(n)}`;
}

// 32 random bytes (256 bits) as URL-safe base64 — safe to carry in a URL fragment.
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export interface CreatedAccount {
  username: string;
  token: string;
}

// Postgres SQLSTATE for unique_violation.
const UNIQUE_VIOLATION = '23505';

// drizzle-orm wraps the driver error in a DrizzleQueryError and puts the real
// node-postgres DatabaseError (which carries the SQLSTATE `code`) on `.cause`,
// so the code is not on the top-level error. Walk the cause chain to find it.
// Depth-capped so a self-referential cause can't loop forever.
function isUniqueViolation(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; e != null && typeof e === 'object' && depth < 8; depth++) {
    if ((e as { code?: unknown }).code === UNIQUE_VIOLATION) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

// `genUsername` is injectable so tests can force a deterministic collision
// without mocking the ES-module namespace (which is fragile under module caching).
export async function createAccount(
  db: Db,
  ip: string | null,
  genUsername: () => string = generateUsername,
): Promise<CreatedAccount> {
  const token = generateToken();
  for (let attempt = 0; attempt < 10; attempt++) {
    const username = genUsername();
    try {
      await db.insert(schema.accounts).values({
        username,
        token,
        ipFirstSeen: ip ?? undefined,
      });
      return { username, token };
    } catch (err: unknown) {
      // unique violation on PK — retry with a freshly generated username
      if (isUniqueViolation(err)) {
        continue;
      }
      throw err;
    }
  }
  throw new RangeError('Failed to generate unique username after 10 attempts');
}
