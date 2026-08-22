// SHA-256 hex of a bearer token — the only form stored in the DB.
import { createHash } from 'node:crypto';

// SHA-256, not a password KDF: the token is 32 random bytes, so brute-force
// is not the threat. A dump of these digests is not a reusable credential —
// auth hashes the presented bearer and compares the digest, so pasting a
// stolen hash back as Authorization fails.
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
