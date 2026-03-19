-- Migration: Add zendesk_preauth_nonces table for single-use pre-auth tokens
CREATE TABLE IF NOT EXISTS zendesk_preauth_nonces (
  nonce TEXT PRIMARY KEY,
  pubkey TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nonces_expires ON zendesk_preauth_nonces(expires_at);
