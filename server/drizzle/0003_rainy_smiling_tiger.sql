-- Hash existing plaintext bearer tokens in place (audit #7058). SHA-256 of
-- the UTF-8 token bytes as hex — the same digest Node's
-- createHash('sha256').update(token, 'utf8').digest('hex') produces. PG 11+
-- sha256() is built-in (no pgcrypto). After this, accounts.token holds only
-- the digest; the plaintext is never stored. Unique constraint follows so
-- two accounts cannot share a credential.
UPDATE "accounts" SET "token" = encode(sha256(convert_to("token", 'UTF8')), 'hex');
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_token_unique" UNIQUE("token");