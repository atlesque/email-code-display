CREATE TABLE IF NOT EXISTS watches (account_id TEXT PRIMARY KEY, subscription_id TEXT, secret TEXT, expires_at INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0);
