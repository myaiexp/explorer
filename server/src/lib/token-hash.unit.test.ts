// Unit tests for hashToken — SHA-256 hex of a bearer token.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { hashToken } from './token-hash.js';

describe('hashToken', () => {
  it('returns the SHA-256 hex digest of the UTF-8 token bytes', () => {
    // Known-answer: sha256("hello") is the published NIST/FIPS vector prefix.
    expect(hashToken('hello')).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
    expect(hashToken('hello')).toBe(
      createHash('sha256').update('hello', 'utf8').digest('hex'),
    );
  });

  it('is not a no-op — the digest is never the plaintext', () => {
    const token = 'a'.repeat(43); // typical base64url length of a 32-byte token
    const digest = hashToken(token);
    expect(digest).not.toBe(token);
    expect(digest).toHaveLength(64);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic and sensitive to any input change', () => {
    expect(hashToken('sekret')).toBe(hashToken('sekret'));
    expect(hashToken('sekret')).not.toBe(hashToken('sekreT'));
  });
});
