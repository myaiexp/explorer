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

export async function createAccount(db: Db, ip: string | null): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const username = generateUsername();
    try {
      await db.insert(schema.accounts).values({
        username,
        ipFirstSeen: ip ?? undefined,
      });
      return username;
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
