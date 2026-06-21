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

export async function createAccount(db: Db, ip: string | null): Promise<CreatedAccount> {
  const token = generateToken();
  for (let attempt = 0; attempt < 10; attempt++) {
    const username = generateUsername();
    try {
      await db.insert(schema.accounts).values({
        username,
        token,
        ipFirstSeen: ip ?? undefined,
      });
      return { username, token };
    } catch (err: unknown) {
      // unique violation on PK — retry
      const pgErr = err as { code?: string };
      if (pgErr?.code === '23505') {
        continue;
      }
      throw err;
    }
  }
  throw new RangeError('Failed to generate unique username after 10 attempts');
}
