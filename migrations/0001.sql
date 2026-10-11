CREATE TABLE accounts (
 id TEXT PRIMARY KEY, provider TEXT NOT NULL CHECK(provider IN ('gmail','outlook')),
 email TEXT NOT NULL, token TEXT NOT NULL, connected_at INTEGER NOT NULL,
 last_checked INTEGER, status TEXT NOT NULL DEFAULT 'connected', UNIQUE(provider,email)
);
CREATE TABLE oauth_states (id TEXT PRIMARY KEY, provider TEXT NOT NULL, verifier TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE processed (account_id TEXT NOT NULL, message_id TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(account_id,message_id));
CREATE TABLE codes (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, payload TEXT NOT NULL, received_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, dismissed INTEGER NOT NULL DEFAULT 0);
CREATE INDEX codes_latest ON codes(dismissed, expires_at, received_at DESC);
CREATE TABLE leases (name TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
