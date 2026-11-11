CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  current_amount REAL NOT NULL DEFAULT 0,
  goal_amount REAL NOT NULL DEFAULT 10000,
  currency TEXT NOT NULL DEFAULT 'RUB',
  updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO settings (id, current_amount, goal_amount, currency, updated_at)
VALUES (1, 0, 10000, 'RUB', datetime('now'));
CREATE TABLE IF NOT EXISTS oauth_state (state TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_tokens (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  payload_enc TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  connected_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS donations (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  counted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS donations_created_at_idx ON donations(created_at);
