CREATE TABLE IF NOT EXISTS accounts (
  account_id TEXT PRIMARY KEY,
  da_user_id TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL,
  payload_enc TEXT,
  token_expires_at INTEGER NOT NULL DEFAULT 0,
  current_amount REAL NOT NULL DEFAULT 0,
  goal_amount REAL NOT NULL DEFAULT 10000,
  currency TEXT NOT NULL DEFAULT 'RUB',
  widget_key_hash TEXT NOT NULL UNIQUE,
  widget_key_enc TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_state (
  state TEXT PRIMARY KEY,
  current_amount REAL NOT NULL,
  goal_amount REAL NOT NULL,
  currency TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS sessions_account_idx ON sessions(account_id);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS donations (
  account_id TEXT NOT NULL,
  donation_id TEXT NOT NULL,
  username TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  counted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, donation_id),
  FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS donations_account_created_idx ON donations(account_id, created_at);
